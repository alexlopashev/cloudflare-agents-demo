import type { IncidentReference } from "../../../../packages/contracts/src/incident";
import type {
  ReleasePreviewEvidence,
  ReleaseSourceEvidence,
} from "../../../../packages/contracts/src/source-evidence";
import { configuredComparisonWindowMs, configuredSlowTraceLimit } from "../agent/evidence-policy";

export type EvidenceReadinessStore = {
  compareReleases(input: {
    baselineReleaseId: string;
    candidateReleaseId: string;
    windowMs: number;
  }): Promise<{ status: string }>;
  findSlowTraces(input: {
    releaseId: string;
    sinceMs: number;
    untilMs: number;
    limit: number;
  }): Promise<readonly { traceId: string; releaseId: string }[]>;
  getTraceDetail(traceId: string): Promise<{
    trace: { traceId: string; releaseId: string };
  } | null>;
  getReleaseSourceEvidence(releaseId: string): Promise<ReleaseSourceEvidence | null>;
  getReleasePreviewEvidence(
    releaseId: string,
    baseSha: string,
  ): Promise<ReleasePreviewEvidence | null>;
};

export async function assertConfiguredEvidenceReady(
  store: EvidenceReadinessStore,
  incident: IncidentReference,
  baseSha: string,
): Promise<void> {
  const [comparison, traces, source, preview] = await Promise.all([
    store.compareReleases({
      baselineReleaseId: incident.baselineReleaseId,
      candidateReleaseId: incident.degradedReleaseId,
      windowMs: configuredComparisonWindowMs,
    }),
    store.findSlowTraces({
      releaseId: incident.degradedReleaseId,
      sinceMs: incident.traceWindow.sinceMs,
      untilMs: incident.traceWindow.untilMs,
      limit: configuredSlowTraceLimit,
    }),
    store.getReleaseSourceEvidence(incident.degradedReleaseId),
    store.getReleasePreviewEvidence(incident.degradedReleaseId, baseSha),
  ]);
  const selectedTrace = traces[0];
  if (
    comparison.status !== "ready" ||
    selectedTrace === undefined ||
    selectedTrace.releaseId !== incident.degradedReleaseId ||
    source === null ||
    preview === null ||
    source.releaseId !== incident.degradedReleaseId ||
    preview.releaseId !== incident.degradedReleaseId ||
    preview.baseSha !== baseSha ||
    source.sourcePath !== preview.sourcePath ||
    source.blobSha !== preview.blobSha ||
    source.byteLength !== preview.byteLength ||
    source.content !== preview.content
  ) {
    throw new TypeError("Configured deployment evidence is incomplete.");
  }
  const detail = await store.getTraceDetail(selectedTrace.traceId);
  if (
    detail === null ||
    detail.trace.traceId !== selectedTrace.traceId ||
    detail.trace.releaseId !== incident.degradedReleaseId
  ) {
    throw new TypeError("Configured deployment trace evidence is incomplete.");
  }
}
