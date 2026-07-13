import { describe, expect, it } from "vitest";

import {
  evidenceInvestigationRequested,
  evidenceStepsFromModelMessages,
  messagesForCurrentInvestigation,
  nextRequiredEvidenceTool,
} from "../../workers/platform/src/agent/evidence-step-policy";

type Step = Parameters<typeof nextRequiredEvidenceTool>[0][number];

function result(toolName: string, input: unknown, output: unknown): Step {
  return {
    toolResults: [{ toolName, input, output }],
  };
}

const compare = result(
  "query_telemetry",
  { operation: "compare-releases" },
  { baseline: { p75Ms: 130 }, candidate: { p75Ms: 380 } },
);
const slow = result(
  "query_telemetry",
  { operation: "find-slow-traces" },
  { traces: [{ traceId: "trace-36" }] },
);
const trace = result(
  "query_telemetry",
  { operation: "inspect-trace", traceId: "trace-36" },
  { traceId: "trace-36", criticalPath: ["api", "jobs", "storage"] },
);
const release = result(
  "inspect_release",
  { versionId: "degraded-release" },
  { commitSha: "d".repeat(40), changedFiles: ["workers/health-service/src/handler.ts"] },
);
const files = result(
  "read_repo_files",
  { commitSha: "d".repeat(40), paths: ["workers/health-service/src/handler.ts"] },
  [{ path: "workers/health-service/src/handler.ts", content: "source" }],
);

describe("Project Think evidence step policy", () => {
  it("does not force tools before an investigation chain begins", () => {
    expect(nextRequiredEvidenceTool([])).toBeUndefined();
    expect(
      evidenceInvestigationRequested([
        { role: "user", content: [{ type: "text", text: "Investigate the latency regression" }] },
      ]),
    ).toBe(true);
    expect(
      evidenceInvestigationRequested([
        { role: "user", content: [{ type: "text", text: "Thanks for the report" }] },
      ]),
    ).toBe(false);
  });

  it("forces each missing capability after the preceding evidence succeeds", () => {
    expect(nextRequiredEvidenceTool([compare])).toBe("query_telemetry");
    expect(nextRequiredEvidenceTool([compare, slow])).toBe("query_telemetry");
    expect(nextRequiredEvidenceTool([compare, slow, trace])).toBe("inspect_release");
    expect(nextRequiredEvidenceTool([compare, slow, trace, release])).toBe("read_repo_files");
    expect(nextRequiredEvidenceTool([compare, slow, trace, release, files])).toBeUndefined();
  });

  it("retries one bounded evidence failure and permits a low-confidence report after two", () => {
    const failedRead = result(
      "read_repo_files",
      { commitSha: "d".repeat(40), paths: ["workers/health-service/src/handler.ts"] },
      { status: "error", code: "unavailable" },
    );

    expect(nextRequiredEvidenceTool([compare, slow, trace, release, failedRead])).toBe(
      "read_repo_files",
    );
    expect(
      nextRequiredEvidenceTool([compare, slow, trace, release, failedRead, failedRead]),
    ).toBeUndefined();
  });

  it("recovers persisted tool input and output from model-message history", () => {
    const historical = evidenceStepsFromModelMessages([
      {
        role: "assistant",
        content: [
          {
            type: "tool-call",
            toolCallId: "compare-call",
            toolName: "query_telemetry",
            input: { operation: "compare-releases" },
          },
        ],
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "compare-call",
            toolName: "query_telemetry",
            output: { type: "json", value: { baseline: {}, candidate: {} } },
          },
        ],
      },
    ]);

    expect(historical).toEqual([
      {
        toolResults: [
          {
            toolCallId: "compare-call",
            toolName: "query_telemetry",
            input: { operation: "compare-releases" },
            output: { baseline: {}, candidate: {} },
          },
        ],
      },
    ]);
  });

  it("does not double-count one tool call observed in messages and current steps", () => {
    const failedRead = {
      toolResults: [
        {
          toolCallId: "read-call",
          toolName: "read_repo_files",
          input: { commitSha: "d".repeat(40), paths: ["workers/health-service/src/handler.ts"] },
          output: { status: "error", code: "unavailable" },
        },
      ],
    };

    expect(nextRequiredEvidenceTool([compare, slow, trace, release, failedRead, failedRead])).toBe(
      "read_repo_files",
    );
  });

  it("starts a new investigation after the latest matching user request", () => {
    const messages = [
      { role: "user", content: [{ type: "text", text: "Investigate the latency regression" }] },
      {
        role: "assistant",
        content: [{ type: "text", text: "Earlier evidence and conclusion" }],
      },
      { role: "user", content: [{ type: "text", text: "Investigate the regression again" }] },
      { role: "assistant", content: [{ type: "text", text: "Current investigation" }] },
    ];

    expect(messagesForCurrentInvestigation(messages)).toEqual(messages.slice(2));
  });
});
