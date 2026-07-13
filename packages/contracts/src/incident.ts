import { z } from "zod";

const evidenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const timestampMs = z.number().int().safe().nonnegative();
const maximumTraceWindowMs = 30 * 24 * 60 * 60 * 1_000;

export const incidentReferenceSchema = z
  .object({
    incidentId: evidenceId,
    baselineReleaseId: evidenceId,
    degradedReleaseId: evidenceId,
    traceWindow: z
      .object({
        sinceMs: timestampMs,
        untilMs: timestampMs.positive(),
      })
      .strict(),
  })
  .strict()
  .superRefine((incident, context) => {
    if (incident.baselineReleaseId === incident.degradedReleaseId) {
      context.addIssue({
        code: "custom",
        message: "Incident releases must be distinct.",
        path: ["degradedReleaseId"],
      });
    }
    const durationMs = incident.traceWindow.untilMs - incident.traceWindow.sinceMs;
    if (durationMs <= 0 || durationMs > maximumTraceWindowMs) {
      context.addIssue({
        code: "custom",
        message: "Incident trace window must be positive and bounded.",
        path: ["traceWindow"],
      });
    }
  });

type ParsedIncidentReference = z.infer<typeof incidentReferenceSchema>;

export type IncidentReference = Readonly<
  Omit<ParsedIncidentReference, "traceWindow"> & {
    traceWindow: Readonly<ParsedIncidentReference["traceWindow"]>;
  }
>;

export type IncidentEnvironment = {
  EVIDENCE_INCIDENT_ID: string;
  EVIDENCE_BASELINE_RELEASE_ID: string;
  EVIDENCE_DEGRADED_RELEASE_ID: string;
  EVIDENCE_DEGRADED_SINCE_MS: string;
  EVIDENCE_DEGRADED_UNTIL_MS: string;
};

export function parseIncidentReference(value: unknown): IncidentReference {
  const parsed = incidentReferenceSchema.safeParse(value);
  if (!parsed.success) throw new TypeError("Configured incident reference is invalid.");
  return Object.freeze({
    ...parsed.data,
    traceWindow: Object.freeze({ ...parsed.data.traceWindow }),
  });
}

function parseTimestamp(value: string): number {
  return /^(?:0|[1-9]\d{0,15})$/.test(value) ? Number(value) : Number.NaN;
}

export function configuredIncidentReference(environment: IncidentEnvironment): IncidentReference {
  return parseIncidentReference({
    incidentId: environment.EVIDENCE_INCIDENT_ID,
    baselineReleaseId: environment.EVIDENCE_BASELINE_RELEASE_ID,
    degradedReleaseId: environment.EVIDENCE_DEGRADED_RELEASE_ID,
    traceWindow: {
      sinceMs: parseTimestamp(environment.EVIDENCE_DEGRADED_SINCE_MS),
      untilMs: parseTimestamp(environment.EVIDENCE_DEGRADED_UNTIL_MS),
    },
  });
}
