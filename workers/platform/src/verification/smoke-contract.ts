import { z } from "zod";

import {
  evidenceErrorCodes,
  evidenceToolNames,
} from "../../../../packages/contracts/src/evidence.ts";
import { incidentReferenceSchema } from "../../../../packages/contracts/src/incident.ts";

const evidenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const safePath = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."));
const completePhase = <T extends (typeof evidenceToolNames)[number]>(toolName: T) =>
  z.object({ toolName: z.literal(toolName), status: z.literal("complete") }).passthrough();
const completePhasesSchema = z.tuple([
  completePhase("compare_releases"),
  completePhase("find_slow_traces"),
  completePhase("inspect_trace"),
  completePhase("inspect_release"),
  completePhase("read_repo_files"),
]);
const evidencePhaseStatusSchema = z.enum(["pending", "complete", "insufficient", "error"]);
const evidenceErrorCodeSchema = z.enum(evidenceErrorCodes);
const invalidEvidenceFieldSchema = z.enum(["investigation", "receipt", "receipt-phases"]);
const smokeVerificationInvalidFieldSchema = z.enum([
  "input-shape",
  "incident-binding",
  "evidence-cross-references",
  "report-sections",
  "remediation-sections",
  "remediation-references",
  "remediation-diff",
]);
const diagnosticPhase = <T extends (typeof evidenceToolNames)[number]>(toolName: T) =>
  z
    .object({
      toolName: z.literal(toolName),
      status: evidencePhaseStatusSchema,
      attempts: z
        .array(
          z
            .object({
              reason: z.string(),
            })
            .passthrough(),
        )
        .max(2)
        .optional(),
    })
    .passthrough();
const diagnosticPhasesSchema = z.tuple([
  diagnosticPhase("compare_releases"),
  diagnosticPhase("find_slow_traces"),
  diagnosticPhase("inspect_trace"),
  diagnosticPhase("inspect_release"),
  diagnosticPhase("read_repo_files"),
]);
const diagnosticInputSchema = z
  .object({
    receipt: z
      .object({
        phases: diagnosticPhasesSchema,
      })
      .passthrough(),
    preparedRemediation: z.unknown().optional(),
  })
  .passthrough();
const inputSchema = z
  .object({
    investigation: z
      .object({
        incident: incidentReferenceSchema,
        receipt: z
          .object({
            investigationId: evidenceId,
            incident: incidentReferenceSchema,
            phases: completePhasesSchema,
            evidence: z
              .object({
                baselineReleaseId: evidenceId,
                degradedReleaseId: evidenceId,
                selectedTraceId: evidenceId,
                inspectedTraceId: evidenceId,
                releaseId: evidenceId,
                commitSha: sha,
                pullRequest: z.object({
                  status: z.literal("found"),
                  number: z.number().int().positive(),
                }),
                sourcePath: safePath,
                blobSha: sha,
              })
              .passthrough(),
          })
          .passthrough(),
        preparedRemediation: z
          .object({
            fingerprint: z.string().regex(/^proposal-v1-[0-9a-f]{16}$/),
            proposal: z
              .object({
                incident: incidentReferenceSchema.safeExtend({
                  traceId: evidenceId,
                  regressionCommitSha: sha,
                  sourcePullRequestNumber: z.number().int().positive(),
                }),
                expectedBaseSha: sha,
                expectedBlobSha: sha,
                path: safePath,
              })
              .passthrough(),
            diff: z
              .object({
                additions: z.number().int().nonnegative(),
                deletions: z.number().int().nonnegative(),
                path: safePath,
              })
              .passthrough(),
          })
          .passthrough(),
        report: z.string().min(1),
      })
      .passthrough(),
    remediation: z
      .object({
        branch: z.string().regex(/^regression-surgeon\/[0-9a-f]{16}$/),
        body: z.string().min(1),
        status: z.literal("preview"),
        writesPerformed: z.literal(false),
      })
      .passthrough(),
  })
  .strict();

export const smokeVerificationReceiptSchema = z
  .object({
    incident: incidentReferenceSchema,
    investigationId: evidenceId,
    phases: z.tuple([
      z.literal("compare_releases"),
      z.literal("find_slow_traces"),
      z.literal("inspect_trace"),
      z.literal("inspect_release"),
      z.literal("read_repo_files"),
    ]),
    crossReferences: z
      .object({
        traceId: evidenceId,
        releaseId: evidenceId,
        commitSha: sha,
        pullRequestNumber: z.number().int().positive(),
        sourcePath: safePath,
        blobSha: sha,
      })
      .strict(),
    reportSections: z.tuple([
      z.literal("Evidence"),
      z.literal("Inference"),
      z.literal("Confidence"),
      z.literal("Unknowns"),
    ]),
    remediation: z
      .object({
        branch: z.string().regex(/^regression-surgeon\/[0-9a-f]{16}$/),
        fingerprint: z.string().regex(/^proposal-v1-[0-9a-f]{16}$/),
        path: safePath,
        additions: z.number().int().nonnegative(),
        deletions: z.number().int().nonnegative(),
        status: z.literal("preview"),
        writesPerformed: z.literal(false),
      })
      .strict(),
  })
  .strict();

export const smokeEvidenceDiagnosticSchema = z
  .object({
    error: z
      .object({
        code: z.enum(["incomplete-evidence-receipt", "invalid-evidence-receipt"]),
        phases: z
          .array(
            z
              .object({
                toolName: z.enum(evidenceToolNames),
                status: evidencePhaseStatusSchema,
                reason: evidenceErrorCodeSchema.optional(),
              })
              .strict(),
          )
          .max(5),
        invalidFields: z.array(invalidEvidenceFieldSchema).max(5).optional(),
      })
      .strict(),
  })
  .strict();

export const smokeRemediationFailureReasonSchema = z.enum([
  "invalid-input",
  "not-allowed",
  "limit-exceeded",
  "stale-base",
  "stale-blob",
  "unavailable",
  "malformed-response",
]);

export const smokePostEvidenceDiagnosticSchema = z.union([
  z
    .object({
      error: z
        .object({
          code: z.literal("remediation-preview-failed"),
          reason: smokeRemediationFailureReasonSchema,
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      error: z
        .object({
          code: z.literal("invalid-smoke-verification"),
          invalidFields: z.array(smokeVerificationInvalidFieldSchema).min(1).max(7),
        })
        .strict(),
    })
    .strict(),
]);

export type SmokeVerificationReceipt = z.infer<typeof smokeVerificationReceiptSchema>;
export type SmokeEvidenceDiagnostic = z.infer<typeof smokeEvidenceDiagnosticSchema>;

export function createSmokeEvidenceDiagnostic(
  investigation: unknown,
): SmokeEvidenceDiagnostic | undefined {
  const parsed = diagnosticInputSchema.safeParse(investigation);
  if (!parsed.success) {
    const invalidFields = Array.from(
      new Set(
        parsed.error.issues.map((issue) => {
          if (issue.path[0] !== "receipt") return "investigation" as const;
          return issue.path[1] === "phases" ? ("receipt-phases" as const) : ("receipt" as const);
        }),
      ),
    ).slice(0, 5);
    return { error: { code: "invalid-evidence-receipt", phases: [], invalidFields } };
  }
  if (
    parsed.data.preparedRemediation !== undefined &&
    parsed.data.receipt.phases.every((phase) => phase.status === "complete")
  ) {
    return undefined;
  }
  return {
    error: {
      code: "incomplete-evidence-receipt",
      phases: parsed.data.receipt.phases.map(({ toolName, status, attempts }) => {
        const reason = evidenceErrorCodeSchema.safeParse(attempts?.at(-1)?.reason);
        return {
          toolName,
          status,
          ...(status === "error" && reason.success ? { reason: reason.data } : {}),
        };
      }),
    },
  };
}

function sameIncident(
  left: z.infer<typeof incidentReferenceSchema>,
  right: z.infer<typeof incidentReferenceSchema>,
): boolean {
  return (
    left.incidentId === right.incidentId &&
    left.baselineReleaseId === right.baselineReleaseId &&
    left.degradedReleaseId === right.degradedReleaseId &&
    left.traceWindow.sinceMs === right.traceWindow.sinceMs &&
    left.traceWindow.untilMs === right.traceWindow.untilMs
  );
}

function includesReference(value: string, reference: string): boolean {
  return value.includes(reference);
}

const reportSectionNames = ["Evidence", "Inference", "Confidence", "Unknowns"] as const;

function reportSectionHeading(line: string): (typeof reportSectionNames)[number] | undefined {
  const trimmed = line.trim();
  const match =
    /^#{1,6}\s+(Evidence|Inference|Confidence|Unknowns)\s*$/i.exec(trimmed) ??
    /^\*\*(Evidence|Inference|Confidence|Unknowns):?\*\*\s*:?\s*$/i.exec(trimmed) ??
    /^__(Evidence|Inference|Confidence|Unknowns):?__\s*:?\s*$/i.exec(trimmed) ??
    /^(Evidence|Inference|Confidence|Unknowns)\s*:\s*$/i.exec(trimmed);
  const section = match?.[1]?.toLowerCase();
  return reportSectionNames.find((name) => name.toLowerCase() === section);
}

function structuredReportSections(report: string): (typeof reportSectionNames)[number][] {
  return report
    .split(/\r?\n/)
    .map(reportSectionHeading)
    .filter((section): section is (typeof reportSectionNames)[number] => section !== undefined);
}

type SmokeVerificationInvalidField = z.infer<typeof smokeVerificationInvalidFieldSchema>;

class SmokeVerificationContractError extends TypeError {
  readonly invalidFields: readonly SmokeVerificationInvalidField[];

  constructor(invalidFields: readonly SmokeVerificationInvalidField[]) {
    super("Smoke verification cross-reference contract failed.");
    this.name = "SmokeVerificationContractError";
    this.invalidFields = invalidFields;
  }
}

export function smokeVerificationFailureDiagnostic(error: unknown) {
  return {
    error: {
      code: "invalid-smoke-verification" as const,
      invalidFields:
        error instanceof SmokeVerificationContractError
          ? [...error.invalidFields]
          : (["input-shape"] satisfies SmokeVerificationInvalidField[]),
    },
  };
}

export function createSmokeVerificationReceipt(input: unknown): SmokeVerificationReceipt {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) throw new SmokeVerificationContractError(["input-shape"]);
  const { investigation, remediation } = parsed.data;
  const { receipt, preparedRemediation } = investigation;
  const evidence = receipt.evidence;
  const proposal = preparedRemediation.proposal;
  const reportSections = structuredReportSections(investigation.report);
  const remediationReferences = [
    investigation.incident.incidentId,
    evidence.selectedTraceId,
    evidence.commitSha,
    `PR #${evidence.pullRequest.number}`,
  ];
  const remediationSections = Array.from(
    remediation.body.matchAll(/^#{1,6}\s+(Evidence|Risk|Validation)\s*$/gim),
    (match) => match[1],
  );
  const incidentBinding =
    sameIncident(investigation.incident, receipt.incident) &&
    sameIncident(investigation.incident, proposal.incident) &&
    evidence.baselineReleaseId === investigation.incident.baselineReleaseId &&
    evidence.degradedReleaseId === investigation.incident.degradedReleaseId &&
    evidence.releaseId === investigation.incident.degradedReleaseId;
  const evidenceCrossReferences =
    evidence.selectedTraceId === evidence.inspectedTraceId &&
    proposal.incident.traceId === evidence.inspectedTraceId &&
    proposal.incident.regressionCommitSha === evidence.commitSha &&
    proposal.incident.sourcePullRequestNumber === evidence.pullRequest.number &&
    proposal.expectedBaseSha === evidence.commitSha &&
    proposal.expectedBlobSha === evidence.blobSha;
  const invalidFields: SmokeVerificationInvalidField[] = [];
  if (!incidentBinding) invalidFields.push("incident-binding");
  if (!evidenceCrossReferences) invalidFields.push("evidence-cross-references");
  if (reportSections.join("|") !== "Evidence|Inference|Confidence|Unknowns") {
    invalidFields.push("report-sections");
  }
  if (remediationSections.join("|") !== "Evidence|Risk|Validation") {
    invalidFields.push("remediation-sections");
  }
  if (!remediationReferences.every((reference) => includesReference(remediation.body, reference))) {
    invalidFields.push("remediation-references");
  }
  if (
    proposal.path !== evidence.sourcePath ||
    preparedRemediation.diff.path !== evidence.sourcePath
  ) {
    invalidFields.push("remediation-diff");
  }
  if (invalidFields.length > 0) throw new SmokeVerificationContractError(invalidFields);

  return smokeVerificationReceiptSchema.parse({
    incident: investigation.incident,
    investigationId: receipt.investigationId,
    phases: evidenceToolNames,
    crossReferences: {
      traceId: evidence.inspectedTraceId,
      releaseId: evidence.releaseId,
      commitSha: evidence.commitSha,
      pullRequestNumber: evidence.pullRequest.number,
      sourcePath: evidence.sourcePath,
      blobSha: evidence.blobSha,
    },
    reportSections,
    remediation: {
      branch: remediation.branch,
      fingerprint: preparedRemediation.fingerprint,
      path: preparedRemediation.diff.path,
      additions: preparedRemediation.diff.additions,
      deletions: preparedRemediation.diff.deletions,
      status: remediation.status,
      writesPerformed: remediation.writesPerformed,
    },
  });
}
