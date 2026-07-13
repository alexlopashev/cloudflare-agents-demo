import { describe, expect, it } from "vitest";

import {
  configuredIncidentReference,
  parseIncidentReference,
} from "../../packages/contracts/src/incident";

const incident = {
  incidentId: "configured-latency-regression",
  baselineReleaseId: "baseline-concurrent",
  degradedReleaseId: "regression-sequential",
  traceWindow: { sinceMs: 1_700_086_400_000, untilMs: 1_700_086_460_000 },
};

describe("incident reference", () => {
  it("validates and freezes one bounded measured release pair", () => {
    const parsed = parseIncidentReference(incident);

    expect(parsed).toEqual(incident);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.traceWindow)).toBe(true);
  });

  it.each([
    { ...incident, incidentId: "" },
    { ...incident, degradedReleaseId: incident.baselineReleaseId },
    { ...incident, traceWindow: { sinceMs: 2_000, untilMs: 1_000 } },
    {
      ...incident,
      traceWindow: { sinceMs: 0, untilMs: 30 * 24 * 60 * 60 * 1_000 + 1 },
    },
  ])("rejects invalid or mismatched incident identity %#", (invalid) => {
    expect(() => parseIncidentReference(invalid)).toThrow(/incident/i);
  });

  it("fails closed when the configured incident is missing or malformed", () => {
    expect(() =>
      configuredIncidentReference({
        EVIDENCE_INCIDENT_ID: "configured-latency-regression",
        EVIDENCE_BASELINE_RELEASE_ID: "baseline-concurrent",
        EVIDENCE_DEGRADED_RELEASE_ID: "regression-sequential",
        EVIDENCE_DEGRADED_SINCE_MS: "",
        EVIDENCE_DEGRADED_UNTIL_MS: "1700086460000",
      }),
    ).toThrow(/incident/i);
  });
});
