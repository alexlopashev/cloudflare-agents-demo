import { describe, expect, it } from "vitest";

import {
  CONTROLLED_HEALTH_DELAY_MS,
  createHealthService,
} from "../../workers/health-service/src/index";

describe("health-service Worker", () => {
  it.each([
    "api",
    "jobs",
    "storage",
  ])("returns deterministic health for %s after the controlled fixture delay", async (serviceId) => {
    const waits: number[] = [];
    const healthService = createHealthService({
      wait: async (delayMs) => {
        waits.push(delayMs);
      },
    });
    const response = await healthService.fetch(
      new Request(`https://health.internal/health/${serviceId}`),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ serviceId, status: "healthy" });
    expect(waits).toEqual([CONTROLLED_HEALTH_DELAY_MS]);
  });

  it("rejects unknown services and methods without waiting", async () => {
    let waitCount = 0;
    const healthService = createHealthService({
      wait: async () => {
        waitCount += 1;
      },
    });
    const unknown = await healthService.fetch(
      new Request("https://health.internal/health/unknown"),
    );
    const method = await healthService.fetch(
      new Request("https://health.internal/health/api", { method: "POST" }),
    );

    expect(unknown.status).toBe(404);
    expect(method.status).toBe(405);
    expect(waitCount).toBe(0);
  });
});
