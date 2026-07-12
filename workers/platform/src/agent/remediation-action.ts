import { action } from "@cloudflare/think";

import { remediationProposalSchema, type RemediationProposal } from "../remediation/service";

type RemediationExecutor = {
  execute(proposal: RemediationProposal): Promise<unknown>;
};

export function createRemediationAction(
  service: RemediationExecutor,
  options: { idempotencyScope: "preview" | "write" },
) {
  return action({
    description:
      "Create or reuse one guarded draft pull request for an evidence-backed latency incident. Requires explicit human approval and cannot merge.",
    inputSchema: remediationProposalSchema,
    kind: "approval-gated",
    approval: true,
    approvalSummary: "Create guarded draft pull request",
    approvalRisk: "high",
    permissions: ["github:draft-pr"],
    idempotencyKey: ({ input }) =>
      `${options.idempotencyScope}:${input.incident.traceId}:${input.expectedBaseSha}:${input.path}`,
    execute: async (proposal) => service.execute(proposal),
  });
}
