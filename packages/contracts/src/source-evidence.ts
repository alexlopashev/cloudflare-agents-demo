import { z } from "zod";

export const configuredSourceEvidencePolicy = Object.freeze({
  repository: Object.freeze({ owner: "alexlopashev", repo: "cloudflare-agents-demo" }),
  pullRequestNumber: 19,
  pullRequestBaseSha: "cf25e5253b106b1e7514340abe94bd42fd748725",
  pullRequestHeadSha: "9af361e5a9420323b2c86f2670e3bf812ac58620",
  regressionCommitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
  sourcePath: "workers/platform/src/api/health.ts",
  maxSourceBytes: 32 * 1_024,
});

const evidenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const immutableSha = z.string().regex(/^[0-9a-f]{40}$/);

export const releaseSourceEvidenceSchema = z
  .object({
    releaseId: evidenceId,
    commitSha: z.literal(configuredSourceEvidencePolicy.regressionCommitSha),
    commitSubject: z
      .string()
      .min(1)
      .max(1_024)
      .refine((subject) =>
        subject.endsWith(`(#${configuredSourceEvidencePolicy.pullRequestNumber})`),
      ),
    committedAt: z.iso.datetime({ offset: true }),
    pullRequestNumber: z.literal(configuredSourceEvidencePolicy.pullRequestNumber),
    pullRequestHeadSha: z.literal(configuredSourceEvidencePolicy.pullRequestHeadSha),
    sourcePath: z.literal(configuredSourceEvidencePolicy.sourcePath),
    blobSha: immutableSha,
    byteLength: z.number().int().positive().max(configuredSourceEvidencePolicy.maxSourceBytes),
    content: z.string().min(1),
  })
  .strict()
  .superRefine((evidence, context) => {
    if (new TextEncoder().encode(evidence.content).byteLength !== evidence.byteLength) {
      context.addIssue({
        code: "custom",
        message: "Configured source byte length does not match its content.",
        path: ["byteLength"],
      });
    }
  });

export type ReleaseSourceEvidence = z.infer<typeof releaseSourceEvidenceSchema>;

export function parseReleaseSourceEvidence(value: unknown): ReleaseSourceEvidence {
  const parsed = releaseSourceEvidenceSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Configured release source evidence is invalid.");
  return parsed.data;
}
