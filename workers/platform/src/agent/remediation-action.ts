import { action } from "@cloudflare/think";
import { z } from "zod";

import { remediationProposalSchema, type RemediationProposal } from "../remediation/service";

type RemediationExecutor = {
  execute(proposal: RemediationProposal): Promise<unknown>;
};

export function createRemediationAction(
  service: RemediationExecutor,
  options: {
    idempotencyScope: "preview" | "write";
    authorize?: (input: RemediationActionInput) => boolean | Promise<boolean>;
  },
) {
  const inputSchema = remediationProposalSchema.safeExtend({
    proposalFingerprint: z.string().regex(/^proposal-v1-[0-9a-f]{16}$/),
  });
  return action({
    description:
      "Create or reuse one guarded draft pull request for an evidence-backed latency incident. Requires explicit human approval and cannot merge.",
    inputSchema,
    kind: "approval-gated",
    approval: true,
    approvalSummary: "Create guarded draft pull request",
    approvalRisk: "high",
    permissions: ["github:draft-pr"],
    idempotencyKey: ({ input }) => `${options.idempotencyScope}:${input.incident.incidentId}`,
    execute: async (rawInput) => {
      const input = inputSchema.parse(rawInput);
      if (options.authorize !== undefined && !(await options.authorize(input))) {
        throw new TypeError("Remediation proposal fingerprint is not authorized by the receipt.");
      }
      const { proposalFingerprint: _proposalFingerprint, ...proposal } = input;
      return service.execute(proposal);
    },
  });
}

export type RemediationActionInput = RemediationProposal & { proposalFingerprint: string };
