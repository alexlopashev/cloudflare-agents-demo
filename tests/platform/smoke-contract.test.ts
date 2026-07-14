import { describe, expect, it } from "vitest";

import {
  createSmokeEvidenceDiagnostic,
  createSmokeVerificationReceipt,
  smokeVerificationFailureDiagnostic,
} from "../../workers/platform/src/verification/smoke-contract";

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
  it("classifies invalid investigation shapes with only bounded whitelisted surfaces", () => {
    const investigation = validInput().investigation;
    investigation.receipt.phases[0] = {
      ...investigation.receipt.phases[0],
      attempts: [
        { reason: "secret-first-detail" },
        { reason: "secret-second-detail" },
        { reason: "secret-third-detail" },
      ],
    } as (typeof investigation.receipt.phases)[number];

    const diagnostic = createSmokeEvidenceDiagnostic(investigation);

    expect(diagnostic).toEqual({
      error: {
        code: "invalid-evidence-receipt",
        phases: [],
        invalidFields: ["receipt-phases"],
      },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("secret");
    expect(createSmokeEvidenceDiagnostic(null)).toEqual({
      error: {
        code: "invalid-evidence-receipt",
        phases: [],
        invalidFields: ["investigation"],
      },
    });
  });

  it("keeps two failed attempts inside the bounded incomplete receipt diagnostic", () => {
    const investigation = validInput().investigation;
    investigation.receipt.phases[0] = {
      ...investigation.receipt.phases[0],
      status: "error",
      attempts: [{ reason: "unavailable" }, { reason: "unavailable" }],
    } as (typeof investigation.receipt.phases)[number];
    delete (investigation as Partial<typeof investigation>).preparedRemediation;

    expect(createSmokeEvidenceDiagnostic(investigation)).toMatchObject({
      error: {
        code: "incomplete-evidence-receipt",
        phases: [
          { toolName: "compare_releases", status: "error", reason: "unavailable" },
          { toolName: "find_slow_traces", status: "complete" },
          { toolName: "inspect_trace", status: "complete" },
          { toolName: "inspect_release", status: "complete" },
          { toolName: "read_repo_files", status: "complete" },
        ],
      },
    });
  });

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

  it("derives evidence cross-references from the structured receipt instead of live report prose", () => {
    const input = validInput();
    input.investigation.report =
      "## Evidence\nThe persisted evidence receipt is complete.\n## Inference\nBounded cause.\n## Confidence\nHigh.\n## Unknowns\nNone material.";

    expect(createSmokeVerificationReceipt(input).crossReferences).toEqual({
      traceId: "scenario-trace-1",
      releaseId: "regression-sequential",
      commitSha,
      pullRequestNumber: 19,
      sourcePath: "workers/platform/src/api/health.ts",
      blobSha,
    });
  });

  it("classifies final verification failures with only whitelisted surface names", () => {
    const input = validInput();
    input.investigation.report = "private model prose without structured sections";
    let failure: unknown;
    try {
      createSmokeVerificationReceipt(input);
    } catch (error) {
      failure = error;
    }

    const diagnostic = smokeVerificationFailureDiagnostic(failure);
    expect(diagnostic).toEqual({
      error: { code: "invalid-smoke-verification", invalidFields: ["report-sections"] },
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
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
