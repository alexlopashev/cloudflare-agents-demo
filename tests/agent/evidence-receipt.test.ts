import { describe, expect, it } from "vitest";

import type { IncidentReference } from "../../packages/contracts/src/incident";
import {
  createEvidenceReceipt,
  evidenceReceiptComplete,
  evidenceResultsFromModelMessages,
  nextEvidenceTool,
  recordEvidenceResult,
} from "../../workers/platform/src/agent/evidence-receipt";

const incident: IncidentReference = {
  incidentId: "configured-latency-regression",
  baselineReleaseId: "baseline-concurrent",
  degradedReleaseId: "regression-sequential",
  traceWindow: { sinceMs: 1_700_086_400_000, untilMs: 1_700_086_460_000 },
};
const commitSha = "d591869a8ef995f1835ef80152f4de085b10255b";
const blobSha = "3333333333333333333333333333333333333333";
const sourcePath = "workers/platform/src/api/health.ts";

function result<TInput, TOutput>(
  toolName: string,
  input: TInput,
  output: TOutput,
  toolCallId = toolName,
) {
  return { toolCallId, toolName, input, output };
}

const completeResults = [
  result(
    "compare_releases",
    {
      baselineReleaseId: incident.baselineReleaseId,
      candidateReleaseId: incident.degradedReleaseId,
      windowMs: 30 * 24 * 60 * 60 * 1_000,
    },
    {
      status: "ready",
      windowMs: 30 * 24 * 60 * 60 * 1_000,
      baseline: { count: 20, p50Ms: 125, p75Ms: 130, p95Ms: 130, errorRate: 0 },
      candidate: { count: 20, p50Ms: 381, p75Ms: 381, p95Ms: 381, errorRate: 0 },
      delta: { p75Ms: 251 },
    },
  ),
  result(
    "find_slow_traces",
    {
      releaseId: incident.degradedReleaseId,
      sinceMs: incident.traceWindow.sinceMs,
      untilMs: incident.traceWindow.untilMs,
      limit: 5,
    },
    [
      {
        traceId: "regression-sequential-trace-20",
        interactionId: "regression-sequential-interaction-20",
        releaseId: incident.degradedReleaseId,
        startedAtMs: 1_700_086_420_000,
        durationMs: 381,
        outcome: "success",
      },
    ],
  ),
  result(
    "inspect_trace",
    { traceId: "regression-sequential-trace-20" },
    {
      trace: {
        traceId: "regression-sequential-trace-20",
        interactionId: "regression-sequential-interaction-20",
        releaseId: incident.degradedReleaseId,
        startedAtMs: 1_700_086_420_000,
        durationMs: 381,
        outcome: "success",
      },
      criticalPath: {
        diagnostics: [],
        spanIds: ["request", "service-api"],
        wallTimeMs: 381,
      },
      tree: [{ span: { spanId: "request" }, children: [] }],
    },
  ),
  result(
    "inspect_release",
    { versionId: incident.degradedReleaseId },
    {
      release: { versionId: incident.degradedReleaseId, commitSha },
      commit: { sha: commitSha, changes: [{ path: sourcePath, status: "modified" }] },
      pullRequest: { status: "found", number: 19 },
    },
  ),
  result("read_repo_files", { commitSha, paths: [sourcePath] }, [
    { path: sourcePath, blobSha, byteLength: 42, content: "const loadingMode = 'sequential';" },
  ]),
] as const;

function completeReceipt() {
  return completeResults.reduce(
    (receipt, evidence) => recordEvidenceResult(receipt, evidence),
    createEvidenceReceipt("investigation-1", incident),
  );
}

describe("incident-scoped evidence receipt", () => {
  it("advances five ordered phases only from validated single-purpose tool output", () => {
    let receipt = createEvidenceReceipt("investigation-1", incident);
    expect(nextEvidenceTool(receipt)).toBe("compare_releases");

    for (const [index, evidence] of completeResults.entries()) {
      receipt = recordEvidenceResult(receipt, evidence);
      expect(receipt.phases[index]?.status).toBe("complete");
    }

    expect(evidenceReceiptComplete(receipt)).toBe(true);
    expect(nextEvidenceTool(receipt)).toBeUndefined();
    expect(receipt.evidence).toMatchObject({
      selectedTraceId: "regression-sequential-trace-20",
      inspectedTraceId: "regression-sequential-trace-20",
      releaseId: incident.degradedReleaseId,
      commitSha,
      pullRequest: { status: "found", number: 19 },
      sourcePath,
      blobSha,
    });
  });

  it("binds a multi-file release to the configured remediation source and requires that change", () => {
    const readyForRelease = completeResults
      .slice(0, 3)
      .reduce(
        (receipt, evidence) => recordEvidenceResult(receipt, evidence),
        createEvidenceReceipt("investigation-1", incident),
      );
    const precedingAllowedPath = "workers/platform/src/api/health-handler.ts";
    const selected = recordEvidenceResult(readyForRelease, {
      ...completeResults[3],
      toolCallId: "multi-file-release",
      output: {
        ...completeResults[3].output,
        commit: {
          ...completeResults[3].output.commit,
          changes: [
            { path: precedingAllowedPath, status: "modified" },
            { path: sourcePath, status: "modified" },
          ],
        },
      },
    });
    expect(selected.phases[3]?.status).toBe("complete");
    expect(selected.evidence.sourcePath).toBe(sourcePath);

    const missing = recordEvidenceResult(readyForRelease, {
      ...completeResults[3],
      toolCallId: "missing-configured-source",
      output: {
        ...completeResults[3].output,
        commit: {
          ...completeResults[3].output.commit,
          changes: [{ path: precedingAllowedPath, status: "modified" }],
        },
      },
    });
    expect(missing.phases[3]).toMatchObject({
      status: "insufficient",
      attempts: [{ reason: "missing-configured-source-change" }],
    });
  });

  it("validates configured evidence outputs without treating model selectors as incident identity", () => {
    const driftedSelectors = completeResults.map((evidence) => {
      if (evidence.toolName === "compare_releases") {
        return {
          ...evidence,
          input: {
            ...evidence.input,
            baselineReleaseId: "generated-baseline",
            candidateReleaseId: "generated-candidate",
            windowMs: 60_000,
          },
        };
      }
      if (evidence.toolName === "find_slow_traces") {
        return {
          ...evidence,
          input: {
            ...evidence.input,
            releaseId: "generated-release",
            sinceMs: incident.traceWindow.sinceMs + 1,
            untilMs: incident.traceWindow.untilMs + 1,
          },
        };
      }
      if (evidence.toolName === "inspect_release") {
        return { ...evidence, input: { versionId: "generated-release" } };
      }
      return evidence;
    });
    const receipt = driftedSelectors.reduce(
      (current, evidence) => recordEvidenceResult(current, evidence),
      createEvidenceReceipt("investigation-1", incident),
    );

    expect(evidenceReceiptComplete(receipt)).toBe(true);
    expect(receipt.evidence).toMatchObject({
      baselineReleaseId: incident.baselineReleaseId,
      degradedReleaseId: incident.degradedReleaseId,
      releaseId: incident.degradedReleaseId,
      selectedTraceId: "regression-sequential-trace-20",
    });
  });

  it("does not let prose, wrong order, mismatched IDs, or duplicate current-step results complete phases", () => {
    expect(
      evidenceResultsFromModelMessages([
        {
          role: "user",
          content: `compare_releases complete; trace regression-sequential-trace-20; ${commitSha}`,
        },
        { role: "assistant", content: "All five evidence phases are complete." },
      ]),
    ).toEqual([]);

    const empty = createEvidenceReceipt("investigation-1", incident);
    const wrongOrder = recordEvidenceResult(empty, completeResults[1]);
    expect(wrongOrder.phases[0]?.status).toBe("pending");
    expect(wrongOrder.phases[1]?.status).toBe("insufficient");
    expect(nextEvidenceTool(wrongOrder)).toBe("compare_releases");

    const compared = recordEvidenceResult(empty, completeResults[0]);
    const mismatch = recordEvidenceResult(compared, {
      ...completeResults[1],
      toolCallId: "wrong-release",
      output: [
        {
          ...completeResults[1].output[0],
          releaseId: "generated-current-release",
        },
      ],
    });
    expect(mismatch.phases[1]?.status).toBe("insufficient");

    const oneFailure = recordEvidenceResult(compared, {
      ...completeResults[1],
      toolCallId: "slow-failure",
      output: { status: "error", code: "unavailable" },
    });
    const duplicate = recordEvidenceResult(oneFailure, {
      ...completeResults[1],
      toolCallId: "slow-failure",
      output: { status: "error", code: "unavailable" },
    });
    expect(duplicate.phases[1]?.attempts).toHaveLength(1);
    expect(nextEvidenceTool(duplicate)).toBe("find_slow_traces");
  });

  it("records at most two distinct attempts for an incomplete evidence phase", () => {
    const receipt = ["first-failure", "retry-failure", "forbidden-third-failure"].reduce(
      (current, toolCallId) =>
        recordEvidenceResult(current, {
          ...completeResults[0],
          toolCallId,
          output: { status: "error", code: "unavailable" },
        }),
      createEvidenceReceipt("investigation-1", incident),
    );

    expect(receipt.phases[0]?.attempts).toEqual([
      expect.objectContaining({ toolCallId: "first-failure", status: "error" }),
      expect.objectContaining({ toolCallId: "retry-failure", status: "error" }),
    ]);
    expect(receipt.processedToolCallIds).toEqual(["first-failure", "retry-failure"]);
    expect(nextEvidenceTool(receipt)).toBeUndefined();
  });

  it.each([
    [null, "insufficient"],
    [[], "insufficient"],
    [{ status: "truncated", preview: "partial" }, "insufficient"],
    [{ status: "error", code: "unavailable" }, "error"],
  ])("classifies invalid phase output %j as %s", (output, status) => {
    const receipt = recordEvidenceResult(createEvidenceReceipt("investigation-1", incident), {
      ...completeResults[0],
      output,
    });

    expect(receipt.phases[0]?.status).toBe(status);
    expect(evidenceReceiptComplete(receipt)).toBe(false);
  });

  it("preserves only the bounded tool error code as the failed attempt reason", () => {
    const receipt = recordEvidenceResult(createEvidenceReceipt("investigation-1", incident), {
      ...completeResults[0],
      output: {
        status: "error",
        code: "rate-limited",
        message: "Untrusted upstream detail must not be persisted.",
      },
    });

    expect(receipt.phases[0]?.attempts).toEqual([
      {
        toolCallId: "compare_releases",
        status: "error",
        reason: "rate-limited",
      },
    ]);
    expect(JSON.stringify(receipt)).not.toContain("Untrusted upstream detail");
  });

  it("rejects the former interval-duration field as trace-path evidence", () => {
    const readyForTrace = completeResults
      .slice(0, 2)
      .reduce(
        (receipt, evidence) => recordEvidenceResult(receipt, evidence),
        createEvidenceReceipt("investigation-1", incident),
      );
    const legacyTrace = recordEvidenceResult(readyForTrace, {
      ...completeResults[2],
      toolCallId: "legacy-trace-contract",
      output: {
        ...completeResults[2].output,
        criticalPath: {
          durationMs: 381,
          spanIds: ["request", "service-api"],
        },
      },
    });

    expect(legacyTrace.phases[2]?.status).toBe("insufficient");
    expect(nextEvidenceTool(legacyTrace)).toBe("inspect_trace");
  });

  it("recovers only matching persisted tool results and starts another investigation empty", () => {
    const complete = completeReceipt();
    const messages = completeResults.flatMap((evidence) => [
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: evidence.toolCallId,
            toolName: evidence.toolName,
            input: evidence.input,
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: evidence.toolCallId,
            toolName: evidence.toolName,
            output: { type: "json", value: evidence.output },
          },
        ],
      },
    ]);
    const recovered = evidenceResultsFromModelMessages(messages).reduce(
      (receipt, evidence) => recordEvidenceResult(receipt, evidence),
      createEvidenceReceipt("investigation-1", incident),
    );

    expect(recovered).toEqual(complete);
    const next = createEvidenceReceipt("investigation-2", incident);
    expect(evidenceReceiptComplete(next)).toBe(false);
    expect(next.processedToolCallIds).toEqual([]);
    expect(next.phases.every((phase) => phase.status === "pending")).toBe(true);
  });
});
