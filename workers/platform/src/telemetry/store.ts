import { summarizeSamples, type UxSample } from "../../../../packages/telemetry/src/metrics";
import {
  buildTraceForest,
  calculateCriticalPath,
  type TraceSpan,
} from "../../../../packages/telemetry/src/traces";

type Outcome = "success" | "partial" | "error";

export type ReleaseRecord = {
  releaseId: string;
  gitSha: string;
  deployedAtMs: number;
};

export type TraceRecord = {
  traceId: string;
  interactionId: string;
  releaseId: string;
  startedAtMs: number;
  durationMs: number;
  outcome: Outcome;
};

export type SpanRecord = {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  serviceId: string;
  startedAtMs: number;
  durationMs: number;
  status: "success" | "error";
};

export type UxEventRecord = {
  interactionId: string;
  traceId: string;
  releaseId: string;
  metricName: "service_grid_ready_ms";
  durationMs: number;
  outcome: Outcome;
  recordedAtMs: number;
};

export type TelemetryStoreOptions = {
  minimumComparisonSamples?: number;
  maxComparisonRows?: number;
  maxTraceRows?: number;
  maxSerializedBytes?: number;
  maxQueryWindowMs?: number;
};

export class TelemetryBoundsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryBoundsError";
  }
}

const defaultOptions = {
  minimumComparisonSamples: 20,
  maxComparisonRows: 1_000,
  maxTraceRows: 500,
  maxSerializedBytes: 128 * 1_024,
  maxQueryWindowMs: 30 * 24 * 60 * 60 * 1_000,
};

function isFiniteNonNegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function requireId(value: string, label: string, maxLength = 128) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value) || value.length > maxLength) {
    throw new TypeError(`${label} is invalid.`);
  }
}

function requireDuration(value: number, label: string) {
  if (!isFiniteNonNegative(value)) throw new TypeError(`${label} is invalid.`);
}

function requireOutcome(value: string): asserts value is Outcome {
  if (value !== "success" && value !== "partial" && value !== "error") {
    throw new TypeError("Telemetry outcome is invalid.");
  }
}

function enforceSerializedBound<T>(value: T, maxBytes: number): T {
  if (new TextEncoder().encode(JSON.stringify(value)).byteLength > maxBytes) {
    throw new TelemetryBoundsError("Telemetry result exceeds the serialized-size bound.");
  }
  return value;
}

function validateRelease(release: ReleaseRecord) {
  requireId(release.releaseId, "Release identifier");
  if (!/^[0-9a-f]{40}$/.test(release.gitSha)) throw new TypeError("Git SHA is invalid.");
  requireDuration(release.deployedAtMs, "Release deployment time");
}

function validateTrace(trace: TraceRecord) {
  requireId(trace.traceId, "Trace identifier");
  requireId(trace.interactionId, "Interaction identifier");
  requireId(trace.releaseId, "Release identifier");
  requireDuration(trace.startedAtMs, "Trace start time");
  requireDuration(trace.durationMs, "Trace duration");
  requireOutcome(trace.outcome);
}

function validateSpan(span: SpanRecord, traceId: string) {
  requireId(span.traceId, "Span trace identifier");
  if (span.traceId !== traceId) throw new TypeError("Span trace identifier does not match.");
  requireId(span.spanId, "Span identifier");
  if (span.parentSpanId !== null) requireId(span.parentSpanId, "Parent span identifier");
  requireId(span.serviceId, "Span service identifier", 80);
  requireDuration(span.startedAtMs, "Span start time");
  requireDuration(span.durationMs, "Span duration");
  if (span.status !== "success" && span.status !== "error") {
    throw new TypeError("Span status is invalid.");
  }
}

export function createTelemetryStore(database: D1Database, options: TelemetryStoreOptions = {}) {
  const policy = { ...defaultOptions, ...options };
  if (
    !Number.isSafeInteger(policy.minimumComparisonSamples) ||
    policy.minimumComparisonSamples < 1 ||
    !Number.isSafeInteger(policy.maxComparisonRows) ||
    policy.maxComparisonRows < policy.minimumComparisonSamples ||
    !Number.isSafeInteger(policy.maxTraceRows) ||
    policy.maxTraceRows < 1 ||
    !Number.isSafeInteger(policy.maxSerializedBytes) ||
    policy.maxSerializedBytes < 1 ||
    !Number.isSafeInteger(policy.maxQueryWindowMs) ||
    policy.maxQueryWindowMs < 1
  ) {
    throw new TypeError("Telemetry store policy is invalid.");
  }

  return {
    async recordTrace(input: {
      release: ReleaseRecord;
      trace: TraceRecord;
      spans: readonly SpanRecord[];
    }) {
      validateRelease(input.release);
      validateTrace(input.trace);
      if (input.trace.releaseId !== input.release.releaseId) {
        throw new TypeError("Trace release identifier does not match.");
      }
      if (input.spans.length > policy.maxTraceRows) {
        throw new TelemetryBoundsError("Trace exceeds the span row bound.");
      }
      for (const span of input.spans) validateSpan(span, input.trace.traceId);

      const existingRelease = await database
        .prepare("SELECT git_sha, deployed_at_ms FROM releases WHERE release_id = ?1 LIMIT 1")
        .bind(input.release.releaseId)
        .first<{ git_sha: string; deployed_at_ms: number }>();
      if (
        existingRelease !== null &&
        (existingRelease.git_sha !== input.release.gitSha ||
          existingRelease.deployed_at_ms !== input.release.deployedAtMs)
      ) {
        throw new TypeError("Release attribution is immutable.");
      }

      const statements = [
        database
          .prepare(
            "INSERT OR IGNORE INTO releases (release_id, git_sha, deployed_at_ms) VALUES (?1, ?2, ?3)",
          )
          .bind(input.release.releaseId, input.release.gitSha, input.release.deployedAtMs),
        database
          .prepare(
            `INSERT OR IGNORE INTO traces
              (trace_id, interaction_id, release_id, started_at_ms, duration_ms, outcome)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
          )
          .bind(
            input.trace.traceId,
            input.trace.interactionId,
            input.trace.releaseId,
            input.trace.startedAtMs,
            input.trace.durationMs,
            input.trace.outcome,
          ),
        ...input.spans.map((span) =>
          database
            .prepare(
              `INSERT OR IGNORE INTO spans
                (trace_id, span_id, parent_span_id, service_id, started_at_ms, duration_ms, status)
               VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
            )
            .bind(
              span.traceId,
              span.spanId,
              span.parentSpanId,
              span.serviceId,
              span.startedAtMs,
              span.durationMs,
              span.status,
            ),
        ),
      ];
      await database.batch(statements);
    },

    async recordUxEvent(event: UxEventRecord) {
      requireId(event.interactionId, "Interaction identifier");
      requireId(event.traceId, "Trace identifier");
      requireId(event.releaseId, "Release identifier");
      if (event.metricName !== "service_grid_ready_ms") {
        throw new TypeError("UX metric is invalid.");
      }
      requireDuration(event.durationMs, "UX duration");
      requireDuration(event.recordedAtMs, "UX event time");
      requireOutcome(event.outcome);
      await database
        .prepare(
          `INSERT OR IGNORE INTO ux_events
            (interaction_id, trace_id, release_id, metric_name, duration_ms, outcome, recorded_at_ms)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
        )
        .bind(
          event.interactionId,
          event.traceId,
          event.releaseId,
          event.metricName,
          event.durationMs,
          event.outcome,
          event.recordedAtMs,
        )
        .run();
    },

    async resetScenarioEvidence(releaseIds: readonly string[]) {
      if (releaseIds.length < 1 || releaseIds.length > 10) {
        throw new TelemetryBoundsError("Scenario reset is outside the release row bound.");
      }
      for (const releaseId of releaseIds) requireId(releaseId, "Release identifier");
      await database.batch(
        releaseIds.flatMap((releaseId) => [
          database.prepare("DELETE FROM ux_events WHERE release_id = ?1").bind(releaseId),
          database
            .prepare(
              "DELETE FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE release_id = ?1)",
            )
            .bind(releaseId),
          database.prepare("DELETE FROM traces WHERE release_id = ?1").bind(releaseId),
          database.prepare("DELETE FROM releases WHERE release_id = ?1").bind(releaseId),
        ]),
      );
    },

    async compareReleases(input: {
      baselineReleaseId: string;
      candidateReleaseId: string;
      windowMs: number;
    }) {
      requireId(input.baselineReleaseId, "Baseline release identifier");
      requireId(input.candidateReleaseId, "Candidate release identifier");
      requireDuration(input.windowMs, "Comparison window");
      if (input.windowMs === 0 || input.windowMs > policy.maxQueryWindowMs) {
        throw new TelemetryBoundsError("Comparison window is outside the time bound.");
      }

      const releaseRows = await database
        .prepare(
          "SELECT release_id, deployed_at_ms FROM releases WHERE release_id IN (?1, ?2) LIMIT 2",
        )
        .bind(input.baselineReleaseId, input.candidateReleaseId)
        .all<{ release_id: string; deployed_at_ms: number }>();
      const releases = new Map(
        releaseRows.results.map((row) => [row.release_id, row.deployed_at_ms] as const),
      );
      const loadSamples = async (releaseId: string): Promise<UxSample[]> => {
        const deployedAtMs = releases.get(releaseId);
        if (deployedAtMs === undefined) return [];
        const rows = await database
          .prepare(
            `SELECT duration_ms, outcome FROM ux_events
             WHERE release_id = ?1 AND metric_name = 'service_grid_ready_ms'
               AND recorded_at_ms >= ?2 AND recorded_at_ms < ?3
             ORDER BY recorded_at_ms, event_id LIMIT ?4`,
          )
          .bind(
            releaseId,
            deployedAtMs,
            deployedAtMs + input.windowMs,
            policy.maxComparisonRows + 1,
          )
          .all<{ duration_ms: number; outcome: Outcome }>();
        if (rows.results.length > policy.maxComparisonRows) {
          throw new TelemetryBoundsError("Comparison exceeds the row bound.");
        }
        return rows.results.map((row) => ({ durationMs: row.duration_ms, outcome: row.outcome }));
      };
      const [baselineSamples, candidateSamples] = await Promise.all([
        loadSamples(input.baselineReleaseId),
        loadSamples(input.candidateReleaseId),
      ]);
      if (
        baselineSamples.length < policy.minimumComparisonSamples ||
        candidateSamples.length < policy.minimumComparisonSamples
      ) {
        return enforceSerializedBound(
          {
            status: "insufficient-data" as const,
            baselineCount: baselineSamples.length,
            candidateCount: candidateSamples.length,
            minimumSamples: policy.minimumComparisonSamples,
            windowMs: input.windowMs,
          },
          policy.maxSerializedBytes,
        );
      }
      const summarize = (samples: UxSample[]) => {
        const summary = summarizeSamples(samples);
        return {
          count: summary.sampleCount,
          p50Ms: summary.p50Ms,
          p75Ms: summary.p75Ms,
          p95Ms: summary.p95Ms,
          errorRate: summary.errorRate,
        };
      };
      const baseline = summarize(baselineSamples);
      const candidate = summarize(candidateSamples);
      if (
        baseline.p50Ms === null ||
        baseline.p75Ms === null ||
        baseline.p95Ms === null ||
        baseline.errorRate === null ||
        candidate.p50Ms === null ||
        candidate.p75Ms === null ||
        candidate.p95Ms === null ||
        candidate.errorRate === null
      ) {
        throw new TypeError("Comparison samples are inconsistent.");
      }
      const p50DeltaMs = candidate.p50Ms - baseline.p50Ms;
      const p75DeltaMs = candidate.p75Ms - baseline.p75Ms;
      const p95DeltaMs = candidate.p95Ms - baseline.p95Ms;
      return enforceSerializedBound(
        {
          status: "ready" as const,
          windowMs: input.windowMs,
          baseline,
          candidate,
          delta: {
            errorRate: candidate.errorRate - baseline.errorRate,
            p50Ms: p50DeltaMs,
            p50Ratio: baseline.p50Ms === 0 ? null : p50DeltaMs / baseline.p50Ms,
            p75Ms: p75DeltaMs,
            p75Ratio: baseline.p75Ms === 0 ? null : p75DeltaMs / baseline.p75Ms,
            p95Ms: p95DeltaMs,
            p95Ratio: baseline.p95Ms === 0 ? null : p95DeltaMs / baseline.p95Ms,
          },
        },
        policy.maxSerializedBytes,
      );
    },

    async findSlowTraces(input: {
      releaseId?: string;
      sinceMs: number;
      untilMs: number;
      limit: number;
    }) {
      if (input.releaseId !== undefined) requireId(input.releaseId, "Release identifier");
      requireDuration(input.sinceMs, "Trace window start");
      requireDuration(input.untilMs, "Trace window end");
      if (
        input.untilMs <= input.sinceMs ||
        input.untilMs - input.sinceMs > policy.maxQueryWindowMs
      ) {
        throw new TelemetryBoundsError("Trace search is outside the time bound.");
      }
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) {
        throw new TelemetryBoundsError("Trace search is outside the row bound.");
      }
      const releaseClause = input.releaseId === undefined ? "" : "AND release_id = ?4";
      const statement = database.prepare(
        `SELECT trace_id, interaction_id, release_id, started_at_ms, duration_ms, outcome
         FROM traces WHERE started_at_ms >= ?1 AND started_at_ms < ?2 ${releaseClause}
         ORDER BY duration_ms DESC, started_at_ms DESC LIMIT ?3`,
      );
      const result =
        input.releaseId === undefined
          ? await statement.bind(input.sinceMs, input.untilMs, input.limit).all<{
              trace_id: string;
              interaction_id: string;
              release_id: string;
              started_at_ms: number;
              duration_ms: number;
              outcome: Outcome;
            }>()
          : await statement.bind(input.sinceMs, input.untilMs, input.limit, input.releaseId).all<{
              trace_id: string;
              interaction_id: string;
              release_id: string;
              started_at_ms: number;
              duration_ms: number;
              outcome: Outcome;
            }>();
      const traces = result.results.map((row) => ({
        traceId: row.trace_id,
        interactionId: row.interaction_id,
        releaseId: row.release_id,
        startedAtMs: row.started_at_ms,
        durationMs: row.duration_ms,
        outcome: row.outcome,
      }));
      return enforceSerializedBound(traces, policy.maxSerializedBytes);
    },

    async getTraceDetail(traceId: string) {
      requireId(traceId, "Trace identifier");
      const [trace, spansResult] = await Promise.all([
        database
          .prepare(
            `SELECT trace_id, interaction_id, release_id, started_at_ms, duration_ms, outcome
             FROM traces WHERE trace_id = ?1 LIMIT 1`,
          )
          .bind(traceId)
          .first<{
            trace_id: string;
            interaction_id: string;
            release_id: string;
            started_at_ms: number;
            duration_ms: number;
            outcome: Outcome;
          }>(),
        database
          .prepare(
            `SELECT span_id, parent_span_id, service_id, started_at_ms, duration_ms, status
             FROM spans WHERE trace_id = ?1 ORDER BY started_at_ms, span_id LIMIT ?2`,
          )
          .bind(traceId, policy.maxTraceRows + 1)
          .all<{
            span_id: string;
            parent_span_id: string | null;
            service_id: string;
            started_at_ms: number;
            duration_ms: number;
            status: "success" | "error";
          }>(),
      ]);
      if (trace === null) return null;
      if (spansResult.results.length > policy.maxTraceRows) {
        throw new TelemetryBoundsError("Trace detail exceeds the row bound.");
      }
      const spans: TraceSpan[] = spansResult.results.map((span) => ({
        spanId: span.span_id,
        parentSpanId: span.parent_span_id,
        serviceId: span.service_id,
        startedAtMs: span.started_at_ms,
        durationMs: span.duration_ms,
        status: span.status === "success" ? "ok" : "error",
      }));
      const detail = {
        trace: {
          traceId: trace.trace_id,
          interactionId: trace.interaction_id,
          releaseId: trace.release_id,
          startedAtMs: trace.started_at_ms,
          durationMs: trace.duration_ms,
          outcome: trace.outcome,
        },
        spans,
        tree: buildTraceForest(spans),
        criticalPath: calculateCriticalPath(spans),
      };
      return enforceSerializedBound(detail, policy.maxSerializedBytes);
    },
  };
}
