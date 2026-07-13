import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import {
  createTelemetryStore,
  TelemetryBoundsError,
} from "../../workers/platform/src/telemetry/store";
import type { PlatformEnvironment } from "../../workers/platform/src/index";

declare global {
  namespace Cloudflare {
    interface Env extends PlatformEnvironment {}
  }
}

const schema = `
  PRAGMA foreign_keys = OFF;
  DROP TABLE IF EXISTS ux_events;
  DROP TABLE IF EXISTS spans;
  DROP TABLE IF EXISTS traces;
  DROP TABLE IF EXISTS releases;
  PRAGMA foreign_keys = ON;
  CREATE TABLE releases (
    release_id TEXT PRIMARY KEY, git_sha TEXT NOT NULL, deployed_at_ms INTEGER NOT NULL
  );
  CREATE TABLE traces (
    trace_id TEXT PRIMARY KEY, interaction_id TEXT NOT NULL, release_id TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL, duration_ms REAL NOT NULL, outcome TEXT NOT NULL,
    FOREIGN KEY (release_id) REFERENCES releases(release_id)
  );
  CREATE TABLE spans (
    trace_id TEXT NOT NULL, span_id TEXT NOT NULL, parent_span_id TEXT, service_id TEXT NOT NULL,
    started_at_ms INTEGER NOT NULL, duration_ms REAL NOT NULL, status TEXT NOT NULL,
    PRIMARY KEY (trace_id, span_id), FOREIGN KEY (trace_id) REFERENCES traces(trace_id)
  );
  CREATE TABLE ux_events (
    event_id INTEGER PRIMARY KEY AUTOINCREMENT, interaction_id TEXT NOT NULL, trace_id TEXT NOT NULL,
    release_id TEXT NOT NULL, metric_name TEXT NOT NULL, duration_ms REAL NOT NULL,
    outcome TEXT NOT NULL, recorded_at_ms INTEGER NOT NULL,
    UNIQUE (interaction_id, metric_name), FOREIGN KEY (trace_id) REFERENCES traces(trace_id),
    FOREIGN KEY (release_id) REFERENCES releases(release_id)
  );
  CREATE TRIGGER reject_conflicting_release BEFORE UPDATE ON releases
  WHEN OLD.git_sha IS NOT NEW.git_sha OR OLD.deployed_at_ms IS NOT NEW.deployed_at_ms
  BEGIN SELECT RAISE(ABORT, 'Release attribution is immutable.'); END;
  CREATE TRIGGER reject_conflicting_trace BEFORE UPDATE ON traces
  WHEN OLD.interaction_id IS NOT NEW.interaction_id OR OLD.release_id IS NOT NEW.release_id
    OR OLD.started_at_ms IS NOT NEW.started_at_ms OR OLD.duration_ms IS NOT NEW.duration_ms
    OR OLD.outcome IS NOT NEW.outcome
  BEGIN SELECT RAISE(ABORT, 'Trace identifier conflicts with persisted telemetry.'); END;
  CREATE TRIGGER reject_conflicting_span BEFORE UPDATE ON spans
  WHEN OLD.parent_span_id IS NOT NEW.parent_span_id OR OLD.service_id IS NOT NEW.service_id
    OR OLD.started_at_ms IS NOT NEW.started_at_ms OR OLD.duration_ms IS NOT NEW.duration_ms
    OR OLD.status IS NOT NEW.status
  BEGIN SELECT RAISE(ABORT, 'Span identifier conflicts with persisted telemetry.'); END;
  CREATE TRIGGER validate_ux_event_trace_insert BEFORE INSERT ON ux_events
  WHEN NOT EXISTS (
    SELECT 1 FROM traces WHERE trace_id = NEW.trace_id
      AND interaction_id = NEW.interaction_id AND release_id = NEW.release_id
  )
  BEGIN SELECT RAISE(ABORT, 'UX event attribution does not match its trace.'); END;
  CREATE TRIGGER validate_ux_event_trace_update BEFORE UPDATE ON ux_events
  WHEN NOT EXISTS (
    SELECT 1 FROM traces WHERE trace_id = NEW.trace_id
      AND interaction_id = NEW.interaction_id AND release_id = NEW.release_id
  )
  BEGIN SELECT RAISE(ABORT, 'UX event attribution does not match its trace.'); END;
  CREATE TRIGGER reject_conflicting_ux_event BEFORE UPDATE ON ux_events
  WHEN OLD.trace_id IS NOT NEW.trace_id OR OLD.release_id IS NOT NEW.release_id
    OR OLD.duration_ms IS NOT NEW.duration_ms OR OLD.outcome IS NOT NEW.outcome
    OR OLD.recorded_at_ms IS NOT NEW.recorded_at_ms
  BEGIN SELECT RAISE(ABORT, 'Interaction identifier conflicts with persisted telemetry.'); END;
`;

const gitSha = "0123456789abcdef0123456789abcdef01234567";

function traceInput(
  releaseId: string,
  deployedAtMs: number,
  sequence: number,
  durationMs: number,
  outcome: "success" | "partial" | "error" = "success",
) {
  return {
    release: { releaseId, gitSha, deployedAtMs },
    trace: {
      traceId: `trace-${releaseId}-${sequence}`,
      interactionId: `interaction-${releaseId}-${sequence}`,
      releaseId,
      startedAtMs: deployedAtMs + sequence * 10,
      durationMs,
      outcome,
    },
    spans: [
      {
        traceId: `trace-${releaseId}-${sequence}`,
        spanId: "root",
        parentSpanId: null,
        serviceId: "health-refresh",
        startedAtMs: deployedAtMs + sequence * 10,
        durationMs,
        status: outcome === "error" ? ("error" as const) : ("success" as const),
      },
    ],
  };
}

describe("D1 telemetry store", () => {
  beforeEach(async () => {
    await env.TELEMETRY_DB.exec(schema.replace(/\s+/g, " "));
  });

  it("persists immutable releases and idempotent traces, spans, and UX events", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    const input = traceInput("release-a", 1_000, 1, 80);

    await expect(store.recordTrace(input)).resolves.toBeUndefined();
    await expect(store.recordTrace(input)).resolves.toBeUndefined();
    const event = {
      interactionId: input.trace.interactionId,
      traceId: input.trace.traceId,
      releaseId: input.trace.releaseId,
      metricName: "service_grid_ready_ms",
      durationMs: 125,
      outcome: "success",
      recordedAtMs: 1_100,
    } as const;
    await expect(store.recordUxEvent(event)).resolves.toBeUndefined();
    await expect(store.recordUxEvent(event)).resolves.toBeUndefined();

    const counts = await env.TELEMETRY_DB.prepare(
      `SELECT
        (SELECT COUNT(*) FROM releases) AS releases,
        (SELECT COUNT(*) FROM traces) AS traces,
        (SELECT COUNT(*) FROM spans) AS spans,
        (SELECT COUNT(*) FROM ux_events) AS events`,
    ).first<{ releases: number; traces: number; spans: number; events: number }>();
    expect(counts).toEqual({ releases: 1, traces: 1, spans: 1, events: 1 });

    await expect(
      store.recordTrace({
        ...input,
        release: { ...input.release, gitSha: "ffffffffffffffffffffffffffffffffffffffff" },
      }),
    ).rejects.toThrow("Release attribution is immutable");
  });

  it("rejects a conflicting trace retry without appending its spans", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    const input = traceInput("release-a", 1_000, 1, 80);
    const root = input.spans[0];
    if (root === undefined) throw new Error("fixture root span is missing");
    await store.recordTrace(input);

    await expect(
      store.recordTrace({
        ...input,
        trace: { ...input.trace, durationMs: 81 },
        spans: [{ ...root, spanId: "conflict-child", parentSpanId: "root" }],
      }),
    ).rejects.toThrow("Trace identifier conflicts with persisted telemetry");

    const counts = await env.TELEMETRY_DB.prepare(
      "SELECT (SELECT COUNT(*) FROM traces) AS traces, (SELECT COUNT(*) FROM spans) AS spans",
    ).first<{ traces: number; spans: number }>();
    expect(counts).toEqual({ traces: 1, spans: 1 });
  });

  it("rejects a conflicting span retry without appending sibling spans", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    const input = traceInput("release-a", 1_000, 1, 80);
    const root = input.spans[0];
    if (root === undefined) throw new Error("fixture root span is missing");
    await store.recordTrace(input);

    await expect(
      store.recordTrace({
        ...input,
        spans: [
          { ...root, serviceId: "conflicting-service" },
          { ...root, spanId: "new-sibling" },
        ],
      }),
    ).rejects.toThrow("Span identifier conflicts with persisted telemetry");

    const spans = await env.TELEMETRY_DB.prepare(
      "SELECT span_id, service_id FROM spans ORDER BY span_id",
    ).all<{ span_id: string; service_id: string }>();
    expect(spans.results).toEqual([{ span_id: "root", service_id: "health-refresh" }]);
  });

  it("rejects conflicting UX retries without replacing the persisted event", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    const input = traceInput("release-a", 1_000, 1, 80);
    await store.recordTrace(input);
    const event = {
      interactionId: input.trace.interactionId,
      traceId: input.trace.traceId,
      releaseId: input.trace.releaseId,
      metricName: "service_grid_ready_ms",
      durationMs: 125,
      outcome: "success",
      recordedAtMs: 1_100,
    } as const;
    await store.recordUxEvent(event);

    await expect(store.recordUxEvent({ ...event, durationMs: 126 })).rejects.toThrow(
      "Interaction identifier conflicts with persisted telemetry",
    );

    const rows = await env.TELEMETRY_DB.prepare(
      "SELECT duration_ms, recorded_at_ms FROM ux_events",
    ).all<{ duration_ms: number; recorded_at_ms: number }>();
    expect(rows.results).toEqual([{ duration_ms: 125, recorded_at_ms: 1_100 }]);
  });

  it("fails UX release and interaction attribution closed against the referenced trace", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    const first = traceInput("release-a", 1_000, 1, 80);
    const second = traceInput("release-b", 2_000, 1, 90);
    await store.recordTrace(first);
    await store.recordTrace(second);
    const event = {
      interactionId: first.trace.interactionId,
      traceId: first.trace.traceId,
      releaseId: first.trace.releaseId,
      metricName: "service_grid_ready_ms",
      durationMs: 125,
      outcome: "success",
      recordedAtMs: 1_100,
    } as const;

    await expect(
      store.recordUxEvent({ ...event, releaseId: second.trace.releaseId }),
    ).rejects.toThrow("UX event attribution does not match its trace");
    await expect(
      store.recordUxEvent({ ...event, interactionId: second.trace.interactionId }),
    ).rejects.toThrow("UX event attribution does not match its trace");

    const count = await env.TELEMETRY_DB.prepare("SELECT COUNT(*) AS events FROM ux_events").first<{
      events: number;
    }>();
    expect(count).toEqual({ events: 0 });
  });

  it("compares equivalent release-relative windows with exact UX statistics", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB, { minimumComparisonSamples: 3 });
    for (const [releaseId, deployedAtMs, durations, outcomes] of [
      ["baseline", 1_000, [100, 200, 300], ["success", "success", "error"]],
      ["candidate", 10_000, [200, 300, 400], ["success", "partial", "success"]],
    ] as const) {
      for (const [index, duration] of durations.entries()) {
        const outcome = outcomes[index] ?? "error";
        const input = traceInput(releaseId, deployedAtMs, index + 1, duration, outcome);
        await store.recordTrace(input);
        await store.recordUxEvent({
          interactionId: input.trace.interactionId,
          traceId: input.trace.traceId,
          releaseId,
          metricName: "service_grid_ready_ms",
          durationMs: duration,
          outcome,
          recordedAtMs: deployedAtMs + (index + 1) * 10,
        });
      }
    }

    const comparison = await store.compareReleases({
      baselineReleaseId: "baseline",
      candidateReleaseId: "candidate",
      windowMs: 100,
    });

    expect(comparison.status).toBe("ready");
    if (comparison.status !== "ready") throw new Error("comparison fixture is incomplete");
    expect(comparison.baseline).toEqual({
      count: 3,
      errorRate: 1 / 3,
      p50Ms: 200,
      p75Ms: 300,
      p95Ms: 300,
    });
    expect(comparison.candidate).toEqual({
      count: 3,
      errorRate: 0,
      p50Ms: 300,
      p75Ms: 400,
      p95Ms: 400,
    });
    expect(comparison.delta).toEqual({
      errorRate: -1 / 3,
      p50Ms: 100,
      p50Ratio: 0.5,
      p75Ms: 100,
      p75Ratio: 1 / 3,
      p95Ms: 100,
      p95Ratio: 1 / 3,
    });
  });

  it("returns bounded slow-trace evidence and overlap-safe trace detail", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    const input = traceInput("release-a", 1_000, 1, 120);
    const root = input.spans[0];
    if (root === undefined) throw new Error("fixture root span is missing");
    await store.recordTrace({
      ...input,
      spans: [
        { ...root, durationMs: 120 },
        {
          ...root,
          spanId: "catalog",
          parentSpanId: "root",
          serviceId: "catalog",
          durationMs: 80,
        },
        {
          ...root,
          spanId: "orphan",
          parentSpanId: "late-parent",
          serviceId: "auth",
          startedAtMs: 1_150,
          durationMs: 30,
        },
      ],
    });

    const slow = await store.findSlowTraces({ sinceMs: 0, untilMs: 2_000, limit: 10 });
    expect(slow).toHaveLength(1);
    expect(slow[0]?.traceId).toBe(input.trace.traceId);

    const detail = await store.getTraceDetail(input.trace.traceId);
    expect(detail?.criticalPath.durationMs).toBe(150);
    expect(detail?.criticalPath.spanIds).toEqual(["catalog", "root", "orphan"]);
    expect(detail?.tree.map((node) => node.span.spanId)).toEqual(["root", "orphan"]);
    expect(detail?.tree[1]?.missingParentSpanId).toBe("late-parent");
  });

  it("rejects unbounded time, row, and serialized-result requests", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB, { maxSerializedBytes: 32 });

    await expect(
      store.findSlowTraces({ sinceMs: 0, untilMs: 1, limit: 101 }),
    ).rejects.toBeInstanceOf(TelemetryBoundsError);
    await expect(store.findSlowTraces({ sinceMs: 2, untilMs: 1, limit: 1 })).rejects.toBeInstanceOf(
      TelemetryBoundsError,
    );

    const input = traceInput("release-a", 1_000, 1, 120);
    await store.recordTrace(input);
    await expect(store.getTraceDetail(input.trace.traceId)).rejects.toBeInstanceOf(
      TelemetryBoundsError,
    );
  });

  it("resets only scenario evidence idempotently", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    await store.recordTrace(traceInput("baseline-concurrent", 1_000, 1, 120));
    await store.recordTrace(traceInput("unrelated-release", 2_000, 1, 80));

    await store.resetScenarioEvidence(["baseline-concurrent", "regression-sequential"]);
    await store.resetScenarioEvidence(["baseline-concurrent", "regression-sequential"]);

    const releases = await env.TELEMETRY_DB.prepare(
      "SELECT release_id FROM releases ORDER BY release_id",
    ).all<{ release_id: string }>();
    expect(releases.results).toEqual([{ release_id: "unrelated-release" }]);
  });

  it("resolves immutable release attribution without exposing SQL", async () => {
    const store = createTelemetryStore(env.TELEMETRY_DB);
    await store.recordTrace(traceInput("release-a", 1_000, 1, 120));

    await expect(store.getReleaseAttribution("release-a")).resolves.toEqual({
      versionId: "release-a",
      commitSha: gitSha,
    });
    await expect(store.getReleaseAttribution("missing-release")).resolves.toBeNull();
  });
});
