import { describe, expect, it, vi } from "vitest";

import { handleUxTelemetryRequest } from "../../workers/platform/src/telemetry/ux-handler";

describe("UX telemetry API", () => {
  it("validates and records one server-timestamped service-grid metric", async () => {
    const recordUxEvent = vi.fn(async () => undefined);
    const response = await handleUxTelemetryRequest(
      new Request("https://example.test/api/telemetry/ux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interactionId: "interaction-1",
          traceId: "trace-1",
          releaseId: "release-1",
          metricName: "service_grid_ready_ms",
          durationMs: 125.5,
          outcome: "partial",
        }),
      }),
      { now: () => 2_000, recordUxEvent },
    );

    expect(response.status).toBe(204);
    expect(recordUxEvent).toHaveBeenCalledExactlyOnceWith({
      interactionId: "interaction-1",
      traceId: "trace-1",
      releaseId: "release-1",
      metricName: "service_grid_ready_ms",
      durationMs: 125.5,
      outcome: "partial",
      recordedAtMs: 2_000,
    });
  });

  it("rejects methods, media types, oversized bodies, extra fields, and invalid metrics before writes", async () => {
    const recordUxEvent = vi.fn(async () => undefined);
    const valid = {
      interactionId: "interaction-1",
      traceId: "trace-1",
      releaseId: "release-1",
      metricName: "service_grid_ready_ms",
      durationMs: 125,
      outcome: "success",
    };
    const requests = [
      new Request("https://example.test/api/telemetry/ux"),
      new Request("https://example.test/api/telemetry/ux", { method: "POST", body: "{}" }),
      new Request("https://example.test/api/telemetry/ux", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "2049" },
        body: "{}",
      }),
      new Request("https://example.test/api/telemetry/ux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...valid, privateDetail: "must not persist" }),
      }),
      new Request("https://example.test/api/telemetry/ux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...valid, metricName: "arbitrary_metric" }),
      }),
    ];

    const responses = await Promise.all(
      requests.map((request) =>
        handleUxTelemetryRequest(request, { now: () => 2_000, recordUxEvent }),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([405, 415, 413, 400, 400]);
    expect(recordUxEvent).not.toHaveBeenCalled();
  });

  it("rejects exhausted public metric traffic before writing telemetry", async () => {
    const recordUxEvent = vi.fn(async () => undefined);
    const limit = vi.fn(async () => ({ success: false }));
    const response = await handleUxTelemetryRequest(
      new Request("https://example.test/api/telemetry/ux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interactionId: "interaction-limited",
          traceId: "trace-limited",
          releaseId: "release-limited",
          metricName: "service_grid_ready_ms",
          durationMs: 125,
          outcome: "success",
        }),
      }),
      {
        now: () => 2_000,
        recordUxEvent,
        publicUsage: { mode: "rate-limited", limiter: { limit } },
      },
    );

    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(await response.json()).toMatchObject({
      error: { code: "public-usage-rate-limited" },
    });
    expect(recordUxEvent).not.toHaveBeenCalled();
  });
});
