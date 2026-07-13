import { describe, expect, it, vi } from "vitest";

import { createRemediationAction } from "../../workers/platform/src/agent/remediation-action";
import type { RemediationProposal } from "../../workers/platform/src/remediation/service";

const proposal: RemediationProposal = {
  incident: {
    incidentId: "configured-latency-regression",
    baselineReleaseId: "baseline-concurrent",
    degradedReleaseId: "regression-sequential",
    traceWindow: { sinceMs: 1_700_086_400_000, untilMs: 1_700_086_460_000 },
    traceId: "scenario-trace-34",
    regressionCommitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
    sourcePullRequestNumber: 19,
  },
  expectedBaseSha: "d591869a8ef995f1835ef80152f4de085b10255b",
  expectedBlobSha: "0cd08624a8881809bd6f0d55a4ec88b358daec64",
  path: "workers/platform/src/api/health.ts",
  replacementContent: "bounded concurrency source",
  title: "fix: bound health-check concurrency",
  rationale: "Preserve pressure control without a serialized critical path.",
  risk: "Two requests can overlap.",
  validationSteps: ["Run mise run check", "Run mise run e2e"],
};
const proposalFingerprint = "proposal-v1-0123456789abcdef";

describe("create_draft_pr Project Think action", () => {
  it("requires explicit approval, a narrow permission, and stable incident idempotency", async () => {
    const service = { execute: vi.fn(async () => ({ status: "preview" as const })) };
    const remediation = createRemediationAction(service, { idempotencyScope: "preview" });

    expect(remediation.config.kind).toBe("approval-gated");
    expect(remediation.config.approval).toBe(true);
    expect(remediation.config.approvalRisk).toBe("high");
    expect(remediation.config.permissions).toEqual(["github:draft-pr"]);
    expect(remediation.config.description).toMatch(/draft pull request/i);

    const idempotency = remediation.config.idempotencyKey;
    if (typeof idempotency !== "function") throw new Error("Expected idempotency function");
    const context = {} as never;
    expect(await idempotency({ input: { ...proposal, proposalFingerprint }, ctx: context })).toBe(
      "preview:configured-latency-regression",
    );
    expect(
      await idempotency({
        input: { ...proposal, proposalFingerprint, replacementContent: "a revised proposal" },
        ctx: context,
      }),
    ).toBe("preview:configured-latency-regression");

    await expect(
      remediation.config.execute({ ...proposal, proposalFingerprint }, context),
    ).resolves.toEqual({
      status: "preview",
    });
    expect(service.execute).toHaveBeenCalledExactlyOnceWith(proposal);
  });
});
