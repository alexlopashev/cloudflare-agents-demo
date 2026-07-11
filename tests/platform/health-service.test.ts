import { describe, expect, it } from "vitest";

import healthService from "../../workers/health-service/src/index";

describe("health-service Worker", () => {
  it("returns bounded deterministic health data", async () => {
    const response = await healthService.fetch(new Request("https://health.test/health"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ service: "health-service", status: "ok" });
  });

  it("rejects routes outside its narrow service contract", async () => {
    const response = await healthService.fetch(new Request("https://health.test/other"));

    expect(response.status).toBe(404);
  });
});
