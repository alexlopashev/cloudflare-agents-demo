import { describe, expect, it, vi } from "vitest";

import { parseIncidentReference } from "../../packages/contracts/src/incident";
import { assertConfiguredEvidenceReady } from "../../workers/platform/src/verification/evidence-readiness";

const incident = parseIncidentReference({
  incidentId: "configured-latency-regression",
  baselineReleaseId: "baseline-version",
  degradedReleaseId: "degraded-version",
  traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
});
const baseSha = "0123456789abcdef0123456789abcdef01234567";
const source = {
  releaseId: "degraded-version",
  commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
  commitSubject: "perf: serialize health checks (#19)",
  committedAt: "2026-07-12T01:42:21.000Z",
  pullRequestNumber: 19,
  pullRequestHeadSha: "9af361e5a9420323b2c86f2670e3bf812ac58620",
  sourcePath: "workers/platform/src/api/health.ts",
  blobSha: "a".repeat(40),
  byteLength: 7,
  content: "source\n",
} as const;

function services() {
  return {
    compareReleases: vi.fn(async () => ({ status: "ready" })),
    findSlowTraces: vi.fn(async () => [{ traceId: "trace-1", releaseId: "degraded-version" }]),
    getTraceDetail: vi.fn(async () => ({
      trace: { traceId: "trace-1", releaseId: "degraded-version" },
    })),
    getReleaseSourceEvidence: vi.fn(async () => source),
    getReleasePreviewEvidence: vi.fn(async () => ({
      releaseId: "degraded-version",
      baseSha,
      sourcePath: source.sourcePath,
      blobSha: source.blobSha,
      byteLength: source.byteLength,
      content: source.content,
    })),
  };
}

describe("configured evidence readiness", () => {
  it("proves the exact configured evidence set without returning its values", async () => {
    const store = services();

    await expect(assertConfiguredEvidenceReady(store, incident, baseSha)).resolves.toBeUndefined();

    expect(store.compareReleases).toHaveBeenCalledExactlyOnceWith({
      baselineReleaseId: "baseline-version",
      candidateReleaseId: "degraded-version",
      windowMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(store.findSlowTraces).toHaveBeenCalledExactlyOnceWith({
      releaseId: "degraded-version",
      sinceMs: 1_000,
      untilMs: 2_000,
      limit: 5,
    });
    expect(store.getTraceDetail).toHaveBeenCalledExactlyOnceWith("trace-1");
    expect(store.getReleasePreviewEvidence).toHaveBeenCalledExactlyOnceWith(
      "degraded-version",
      baseSha,
    );
  });

  it("fails closed when source and preview evidence diverge", async () => {
    const store = services();
    store.getReleasePreviewEvidence.mockResolvedValueOnce({
      releaseId: "degraded-version",
      baseSha,
      sourcePath: source.sourcePath,
      blobSha: "b".repeat(40),
      byteLength: source.byteLength,
      content: source.content,
    });

    await expect(assertConfiguredEvidenceReady(store, incident, baseSha)).rejects.toThrow(
      /evidence is incomplete/i,
    );
    expect(store.getTraceDetail).not.toHaveBeenCalled();
  });
});
