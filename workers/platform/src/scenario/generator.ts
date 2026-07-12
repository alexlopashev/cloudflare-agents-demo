import { createHealthAggregator, type HealthLoadingMode } from "../api/health";
import type { ReleaseRecord, SpanRecord, TraceRecord, UxEventRecord } from "../telemetry/store";

type ScenarioStore = {
  recordTrace(input: {
    release: ReleaseRecord;
    trace: TraceRecord;
    spans: readonly SpanRecord[];
  }): Promise<void>;
  recordUxEvent(event: UxEventRecord): Promise<void>;
};

type ScenarioOptions = {
  goodGitSha: string;
  badGitSha: string;
  sampleCount: number;
  fetcher: (request: Request) => Promise<Response>;
  createTraceId: () => string;
  now: () => number;
  store: ScenarioStore;
};

export const scenarioReleaseIds = ["baseline-concurrent", "regression-sequential"] as const;
export const baselineDeployedAtMs = 1_700_000_000_000;
export const degradedDeployedAtMs = baselineDeployedAtMs + 86_400_000;

function requireGitSha(value: string) {
  if (!/^[0-9a-f]{40}$/.test(value)) throw new TypeError("Scenario Git SHA is invalid.");
}

export async function generateRegressionScenario(options: ScenarioOptions) {
  requireGitSha(options.goodGitSha);
  requireGitSha(options.badGitSha);
  if (
    !Number.isSafeInteger(options.sampleCount) ||
    options.sampleCount < 1 ||
    options.sampleCount > 100
  ) {
    throw new TypeError("Scenario sample count is invalid.");
  }

  const releases = [
    {
      release: {
        releaseId: scenarioReleaseIds[0],
        gitSha: options.goodGitSha,
        deployedAtMs: baselineDeployedAtMs,
      },
      loadingMode: "concurrent" as const,
    },
    {
      release: {
        releaseId: scenarioReleaseIds[1],
        gitSha: options.badGitSha,
        deployedAtMs: degradedDeployedAtMs,
      },
      loadingMode: "sequential" as const,
    },
  ];

  for (const { release, loadingMode } of releases) {
    for (let index = 0; index < options.sampleCount; index += 1) {
      const interactionId = `${release.releaseId}-${index + 1}`;
      const serviceSpans: SpanRecord[] = [];
      const measuredAtMs = options.now();
      const report = await createHealthAggregator({
        fetcher: options.fetcher,
        createTraceId: options.createTraceId,
        loadingMode: loadingMode satisfies HealthLoadingMode,
        now: options.now,
        observeSpan: (span) => serviceSpans.push(span),
      }).collect({ interactionId, releaseId: release.releaseId });
      const measuredUntilMs = options.now();
      const durationMs = Math.max(0, measuredUntilMs - measuredAtMs);
      const startedAtMs = release.deployedAtMs + 1_000 + index * 1_000;
      const outcome =
        report.outcome === "healthy"
          ? ("success" as const)
          : report.outcome === "partial"
            ? ("partial" as const)
            : ("error" as const);
      const spans: SpanRecord[] = [
        {
          traceId: report.traceId,
          spanId: "request",
          parentSpanId: null,
          serviceId: "platform",
          startedAtMs,
          durationMs,
          status: outcome === "error" ? "error" : "success",
        },
        ...serviceSpans.map((span) => ({
          ...span,
          startedAtMs: startedAtMs + Math.max(0, span.startedAtMs - measuredAtMs),
        })),
      ];
      await options.store.recordTrace({
        release,
        trace: {
          traceId: report.traceId,
          interactionId,
          releaseId: release.releaseId,
          startedAtMs,
          durationMs,
          outcome,
        },
        spans,
      });
      await options.store.recordUxEvent({
        interactionId,
        traceId: report.traceId,
        releaseId: release.releaseId,
        metricName: "service_grid_ready_ms",
        durationMs: durationMs + 5,
        outcome,
        recordedAtMs: startedAtMs + durationMs,
      });
    }
  }

  return {
    baselineReleaseId: scenarioReleaseIds[0],
    degradedReleaseId: scenarioReleaseIds[1],
    sampleCount: options.sampleCount,
  };
}
