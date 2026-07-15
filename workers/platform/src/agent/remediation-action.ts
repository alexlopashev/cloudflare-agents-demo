import { action } from "@cloudflare/think";
import { z } from "zod";

import type { RemediationProposal } from "../remediation/service";

type RemediationExecutor = {
  execute(proposal: RemediationProposal): Promise<unknown>;
};

const remediationActionInputSchema = z
  .object({
    proposalFingerprint: z.string().regex(/^proposal-v1-[0-9a-f]{16}$/),
  })
  .strict();

export function createRemediationAction(
  service: RemediationExecutor,
  options: {
    idempotencyScope: "preview" | "write";
    resolveProposal(proposalFingerprint: string): RemediationProposal | undefined;
  },
) {
  const resolveProposal = (proposalFingerprint: string) => {
    const proposal = options.resolveProposal(proposalFingerprint);
    if (proposal === undefined) {
      throw new TypeError("Remediation proposal fingerprint is not authorized by the receipt.");
    }
    return proposal;
  };
  return action({
    description:
      "Create or reuse one guarded draft pull request for an evidence-backed latency incident. Requires explicit human approval and cannot merge.",
    inputSchema: remediationActionInputSchema,
    kind: "approval-gated",
    approval: true,
    approvalSummary: "Create guarded draft pull request",
    approvalRisk: "high",
    permissions: ["github:draft-pr"],
    idempotencyKey: ({ input }) =>
      `${options.idempotencyScope}:${resolveProposal(input.proposalFingerprint).incident.incidentId}`,
    execute: async (rawInput) => {
      const input = remediationActionInputSchema.parse(rawInput);
      return service.execute(resolveProposal(input.proposalFingerprint));
    },
  });
}

export type RemediationActionInput = z.infer<typeof remediationActionInputSchema>;
