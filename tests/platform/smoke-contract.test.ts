import { describe, expect, it } from "vitest";

import { createSmokeVerificationReceipt } from "../../workers/platform/src/verification/smoke-contract";

const incident = {
  incidentId: "configured-latency-regression",
  baselineReleaseId: "baseline-concurrent",
  degradedReleaseId: "regression-sequential",
  traceWindow: { sinceMs: 1_700_086_400_000, untilMs: 1_700_086_460_000 },
};
const commitSha = "d591869f87ef91a35a5ec66588351e3db25b13d8";
const blobSha = "3333333333333333333333333333333333333333";

function validInput() {
  return {
    investigation: {
      incident,
      receipt: {
        investigationId: "investigation-1",
        incident,
        phases: [
          { toolName: "compare_releases", status: "complete" },
          { toolName: "find_slow_traces", status: "complete" },
          { toolName: "inspect_trace", status: "complete" },
          { toolName: "inspect_release", status: "complete" },
          { toolName: "read_repo_files", status: "complete" },
        ],
        evidence: {
          baselineReleaseId: incident.baselineReleaseId,
          degradedReleaseId: incident.degradedReleaseId,
          selectedTraceId: "scenario-trace-1",
          inspectedTraceId: "scenario-trace-1",
          releaseId: incident.degradedReleaseId,
          commitSha,
          pullRequest: { status: "found", number: 19 },
          sourcePath: "workers/platform/src/api/health.ts",
          blobSha,
        },
      },
      preparedRemediation: {
        fingerprint: "proposal-v1-0123456789abcdef",
        proposal: {
          incident: {
            ...incident,
            traceId: "scenario-trace-1",
            regressionCommitSha: commitSha,
            sourcePullRequestNumber: 19,
          },
          expectedBaseSha: commitSha,
          expectedBlobSha: blobSha,
          path: "workers/platform/src/api/health.ts",
        },
        diff: {
          additions: 4,
          deletions: 4,
          path: "workers/platform/src/api/health.ts",
        },
      },
      report:
        "## Evidence\ninvestigation-1 configured-latency-regression scenario-trace-1 d591869 PR #19\n## Inference\nBounded cause.\n## Confidence\nHigh.\n## Unknowns\nNone material.",
    },
    remediation: {
      branch: "regression-surgeon/0123456789abcdef",
      body: "## Evidence\nconfigured-latency-regression scenario-trace-1 d591869f87ef91a35a5ec66588351e3db25b13d8 PR #19\n## Risk\nBounded.\n## Validation\nRun gates.",
      status: "preview",
      writesPerformed: false,
    },
  };
}

describe("deployment smoke verification receipt", () => {
  it("returns the five exact phases, cross-references, report sections, and zero-write remediation", () => {
    expect(createSmokeVerificationReceipt(validInput())).toEqual({
      incident,
      investigationId: "investigation-1",
      phases: [
        "compare_releases",
        "find_slow_traces",
        "inspect_trace",
        "inspect_release",
        "read_repo_files",
      ],
      crossReferences: {
        traceId: "scenario-trace-1",
        releaseId: "regression-sequential",
        commitSha,
        pullRequestNumber: 19,
        sourcePath: "workers/platform/src/api/health.ts",
        blobSha,
      },
      reportSections: ["Evidence", "Inference", "Confidence", "Unknowns"],
      remediation: {
        branch: "regression-surgeon/0123456789abcdef",
        fingerprint: "proposal-v1-0123456789abcdef",
        path: "workers/platform/src/api/health.ts",
        additions: 4,
        deletions: 4,
        status: "preview",
        writesPerformed: false,
      },
    });
  });

  it.each([
    ["phase", (input: ReturnType<typeof validInput>) => input.investigation.receipt.phases.pop()],
    [
      "cross-reference",
      (input: ReturnType<typeof validInput>) =>
        (input.investigation.receipt.evidence.inspectedTraceId = "other-trace"),
    ],
    [
      "report section",
      (input: ReturnType<typeof validInput>) =>
        (input.investigation.report = input.investigation.report.replace("## Unknowns", "## Gaps")),
    ],
    [
      "fingerprint",
      (input: ReturnType<typeof validInput>) =>
        (input.investigation.preparedRemediation.fingerprint = "wrong"),
    ],
    [
      "zero-write result",
      (input: ReturnType<typeof validInput>) => (input.remediation.writesPerformed = true),
    ],
    [
      "remediation sections",
      (input: ReturnType<typeof validInput>) =>
        (input.remediation.body = input.remediation.body.replace("## Risk", "## Guess")),
    ],
  ])("fails when the exact %s contract is missing", (_label, mutate) => {
    const input = validInput();
    mutate(input);
    expect(() => createSmokeVerificationReceipt(input)).toThrow(/smoke verification/i);
  });
});
