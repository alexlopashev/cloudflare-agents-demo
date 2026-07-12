import { describe, expect, it, vi } from "vitest";

import type { HealthReport } from "../../packages/contracts/src/health";
import {
  DeployboardMetricsError,
  metricSampleCounts,
  runDeployboardMetricBatch,
} from "../../apps/web/src/deployboard/client";

function report(interactionId: string): HealthReport {
  return {
    interactionId,
    traceId: `trace-${interactionId}`,
    releaseId: "release-current",
    outcome: "healthy",
    services: [
      { id: "api", label: "API gateway", status: "healthy" },
      { id: "jobs", label: "Job runner", status: "healthy" },
      { id: "storage", label: "Object storage", status: "healthy" },
    ],
  };
}

describe("Deployboard metric generation", () => {
  it("exposes only bounded sample choices and rejects invalid counts before network I/O", async () => {
    expect(metricSampleCounts).toEqual([5, 10, 20]);
    const fetcher = vi.fn(async () => new Response());

    for (const sampleCount of [0, 4, 6, 21, 5.5]) {
      await expect(
        runDeployboardMetricBatch({
          sampleCount,
          createInteractionId: () => "metric-invalid",
          fetcher,
          emitCompletion: vi.fn(),
          onProgress: vi.fn(),
        }),
      ).rejects.toThrow("Metric sample count is invalid.");
    }

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("runs samples sequentially and counts each one only after telemetry acknowledges it", async () => {
    const calls: string[] = [];
    const identifiers = Array.from({ length: 5 }, (_, index) => `metric-${index + 1}`);
    const fetcher = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/health") {
        const body = (await request.json()) as { interactionId: string };
        calls.push(`health:${body.interactionId}`);
        return Response.json(report(body.interactionId));
      }
      const body = (await request.json()) as { interactionId: string };
      calls.push(`telemetry:${body.interactionId}`);
      return new Response(null, { status: 204 });
    });
    const onProgress = vi.fn();

    await expect(
      runDeployboardMetricBatch({
        sampleCount: 5,
        createInteractionId: () => identifiers.shift() ?? "unexpected",
        fetcher,
        emitCompletion: vi.fn(),
        onProgress,
      }),
    ).resolves.toMatchObject({ sampleCount: 5, latestReport: report("metric-5") });

    expect(calls).toEqual([
      "health:metric-1",
      "telemetry:metric-1",
      "health:metric-2",
      "telemetry:metric-2",
      "health:metric-3",
      "telemetry:metric-3",
      "health:metric-4",
      "telemetry:metric-4",
      "health:metric-5",
      "telemetry:metric-5",
    ]);
    expect(onProgress.mock.calls.map(([progress]) => progress.completed)).toEqual([1, 2, 3, 4, 5]);
  });

  it("stops visibly at the first unacknowledged telemetry sample", async () => {
    let nextIdentifier = 0;
    let telemetryCalls = 0;
    const fetcher = vi.fn(async (request: Request) => {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/api/health") {
        const body = (await request.json()) as { interactionId: string };
        return Response.json(report(body.interactionId));
      }
      telemetryCalls += 1;
      return new Response(null, { status: telemetryCalls === 2 ? 503 : 204 });
    });
    const onProgress = vi.fn();

    await expect(
      runDeployboardMetricBatch({
        sampleCount: 5,
        createInteractionId: () => {
          nextIdentifier += 1;
          return `metric-${nextIdentifier}`;
        },
        fetcher,
        emitCompletion: vi.fn(),
        onProgress,
      }),
    ).rejects.toEqual(new DeployboardMetricsError("Metric generation failed."));

    expect(onProgress).toHaveBeenCalledOnce();
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
