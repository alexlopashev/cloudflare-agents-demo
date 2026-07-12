import { describe, expect, it, vi } from "vitest";

import { createAgentEvidenceServices } from "../../workers/platform/src/agent/evidence-services";

const regressionSha = "d591869a8ef995f1835ef80152f4de085b10255b";

function telemetryStore() {
  return {
    compareReleases: vi.fn(async () => ({ status: "ready" })),
    findSlowTraces: vi.fn(async () => []),
    getTraceDetail: vi.fn(async () => null),
    getReleaseAttribution: vi.fn(async (releaseId: string) => ({
      versionId: releaseId,
      commitSha: regressionSha,
    })),
  };
}

describe("agent evidence services", () => {
  it("uses deterministic immutable repository evidence in credential-free fake mode", async () => {
    const store = telemetryStore();
    const fetcher = vi.fn(async () => new Response("network must not be used"));
    const services = createAgentEvidenceServices({
      mode: "fake",
      repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
      store,
      fetcher,
    });

    await expect(
      services.repository.inspectRelease("regression-sequential"),
    ).resolves.toMatchObject({
      release: { versionId: "regression-sequential", commitSha: regressionSha },
      commit: {
        sha: regressionSha,
        message: expect.stringContaining("serialize health checks"),
      },
      pullRequest: { status: "found", number: 19 },
    });
    await expect(
      services.repository.readFiles({
        commitSha: regressionSha,
        paths: ["workers/platform/src/api/health.ts"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        path: "workers/platform/src/api/health.ts",
        content: expect.stringContaining('loadingMode === "sequential"'),
      }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("fails closed for mismatched fake attribution and unsupported modes", async () => {
    const store = telemetryStore();
    store.getReleaseAttribution.mockResolvedValue({
      versionId: "regression-sequential",
      commitSha: "1111111111111111111111111111111111111111",
    });
    const fake = createAgentEvidenceServices({
      mode: "fake",
      repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
      store,
    });

    await expect(fake.repository.inspectRelease("regression-sequential")).rejects.toMatchObject({
      code: "malformed-response",
    });
    expect(() =>
      createAgentEvidenceServices({
        mode: "unsupported",
        repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
        store,
      }),
    ).toThrow("Unsupported evidence mode");
  });
});
