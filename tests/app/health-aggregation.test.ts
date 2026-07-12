import { describe, expect, it, vi } from "vitest";

import { serviceDefinitions } from "../../packages/contracts/src/health";
import { createHealthAggregator } from "../../workers/platform/src/api/health";

function healthy(serviceId: string): Response {
  return Response.json({ serviceId, status: "healthy" });
}

describe("health aggregation", () => {
  it("starts every dependency concurrently and preserves configured output order", async () => {
    const pending = new Map(
      serviceDefinitions.map((service) => [service.id, Promise.withResolvers<Response>()]),
    );
    const started: string[] = [];
    const fetcher = vi.fn((request: Request) => {
      const serviceId = request.headers.get("x-service-id") ?? "";
      started.push(serviceId);
      const deferred = [...pending.entries()].find(([id]) => id === serviceId)?.[1];
      if (!deferred) throw new Error("unexpected service");
      return deferred.promise;
    });
    const aggregator = createHealthAggregator({
      fetcher,
      createTraceId: () => "trace-1",
    });

    const reportPromise = aggregator.collect({
      interactionId: "interaction-1",
      releaseId: "release-good",
    });
    expect(started).toEqual(serviceDefinitions.map((service) => service.id));

    pending.get("storage")?.resolve(healthy("storage"));
    pending.get("jobs")?.resolve(healthy("jobs"));
    pending.get("api")?.resolve(healthy("api"));

    await expect(reportPromise).resolves.toEqual({
      interactionId: "interaction-1",
      traceId: "trace-1",
      releaseId: "release-good",
      outcome: "healthy",
      services: serviceDefinitions.map((service) => ({ ...service, status: "healthy" })),
    });
    for (const call of fetcher.mock.calls) {
      const request = call[0];
      expect(request.headers.get("x-interaction-id")).toBe("interaction-1");
      expect(request.headers.get("x-trace-id")).toBe("trace-1");
    }
  });

  it("returns a bounded partial result for thrown, HTTP, and malformed dependency failures", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      const serviceId = request.headers.get("x-service-id");
      if (serviceId === "api") return healthy("api");
      if (serviceId === "jobs") return new Response("private upstream detail", { status: 503 });
      throw new Error("private transport detail");
    });
    const aggregator = createHealthAggregator({ fetcher, createTraceId: () => "trace-partial" });

    const report = await aggregator.collect({
      interactionId: "interaction-partial",
      releaseId: "release-good",
    });

    expect(report.outcome).toBe("partial");
    expect(report.services).toEqual([
      { id: "api", label: "API gateway", status: "healthy" },
      {
        id: "jobs",
        label: "Job runner",
        status: "unavailable",
        error: { code: "dependency-unavailable", message: "Health check unavailable." },
      },
      {
        id: "storage",
        label: "Object storage",
        status: "unavailable",
        error: { code: "dependency-unavailable", message: "Health check unavailable." },
      },
    ]);
    expect(JSON.stringify(report)).not.toContain("private");

    fetcher.mockImplementation(async (request: Request) =>
      Response.json({ serviceId: request.headers.get("x-service-id"), status: "unknown" }),
    );
    const failed = await aggregator.collect({
      interactionId: "interaction-failed",
      releaseId: "release-good",
    });
    expect(failed.outcome).toBe("failed");
    expect(failed.services.every((service) => service.status === "unavailable")).toBe(true);
  });

  it("rejects invalid identifiers before calling a dependency", async () => {
    const fetcher = vi.fn(async () => healthy("api"));
    const aggregator = createHealthAggregator({ fetcher, createTraceId: () => "invalid trace" });

    await expect(
      aggregator.collect({ interactionId: "../invalid", releaseId: "release-good" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      aggregator.collect({ interactionId: "interaction-1", releaseId: "release-good" }),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("observes one bounded service span for every successful or failed binding call", async () => {
    const spans: unknown[] = [];
    let now = 100;
    const aggregator = createHealthAggregator({
      fetcher: async (request) => {
        if (request.headers.get("x-service-id") === "jobs") throw new Error("private failure");
        return healthy(request.headers.get("x-service-id") ?? "");
      },
      createTraceId: () => "trace-spans",
      now: () => (now += 10),
      observeSpan: (span) => spans.push(span),
    });

    await aggregator.collect({ interactionId: "interaction-spans", releaseId: "release-good" });

    expect(spans).toHaveLength(3);
    expect(spans).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          spanId: "service-api",
          parentSpanId: "request",
          serviceId: "api",
          status: "success",
          traceId: "trace-spans",
        }),
        expect.objectContaining({
          spanId: "service-jobs",
          parentSpanId: "request",
          serviceId: "jobs",
          status: "error",
          traceId: "trace-spans",
        }),
      ]),
    );
    for (const span of spans as { durationMs: number }[]) {
      expect(span.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});
