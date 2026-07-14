import { describe, expect, it, vi } from "vitest";

import { handleHealthApiRequest } from "../../workers/platform/src/api/health-handler";

describe("health API", () => {
  it("returns a no-store report with stable interaction, trace, and release identifiers", async () => {
    const fetcher = vi.fn(async (request: Request) =>
      Response.json({ serviceId: request.headers.get("x-service-id"), status: "healthy" }),
    );
    const response = await handleHealthApiRequest(
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: "interaction-1" }),
      }),
      { fetcher, releaseId: "release-good", createTraceId: () => "trace-1" },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      interactionId: "interaction-1",
      traceId: "trace-1",
      releaseId: "release-good",
      outcome: "healthy",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("rejects unsupported methods, media types, oversized bodies, and invalid input before I/O", async () => {
    const fetcher = vi.fn(async () => new Response());
    const options = { fetcher, releaseId: "release-good", createTraceId: () => "trace-1" };
    const cases = [
      new Request("https://example.test/api/health"),
      new Request("https://example.test/api/health", { method: "POST", body: "{}" }),
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: { "content-type": "application/jsonp" },
        body: JSON.stringify({ interactionId: "interaction-1" }),
      }),
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": "2049" },
        body: "{}",
      }),
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: "../invalid" }),
      }),
    ];

    const responses = await Promise.all(
      cases.map((request) => handleHealthApiRequest(request, options)),
    );
    expect(responses.map((response) => response.status)).toEqual([405, 415, 415, 413, 400]);
    expect(fetcher).not.toHaveBeenCalled();
    for (const response of responses) {
      const body = (await response.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBeTruthy();
      expect(JSON.stringify(body)).not.toContain("invalid trace");
    }
  });

  it("records release-attributed request and service spans before returning evidence", async () => {
    const recordTrace = vi.fn(async () => undefined);
    let now = 1_000;
    const response = await handleHealthApiRequest(
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: "interaction-telemetry" }),
      }),
      {
        fetcher: async (request) =>
          Response.json({ serviceId: request.headers.get("x-service-id"), status: "healthy" }),
        releaseId: "release-good",
        createTraceId: () => "trace-telemetry",
        gitSha: "0123456789abcdef0123456789abcdef01234567",
        deployedAtMs: 900,
        now: () => (now += 10),
        recordTrace,
      },
    );

    expect(response.status).toBe(200);
    expect(recordTrace).toHaveBeenCalledOnce();
    expect(recordTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        release: {
          releaseId: "release-good",
          gitSha: "0123456789abcdef0123456789abcdef01234567",
          deployedAtMs: 900,
        },
        trace: expect.objectContaining({
          traceId: "trace-telemetry",
          interactionId: "interaction-telemetry",
          outcome: "success",
        }),
        spans: expect.arrayContaining([
          expect.objectContaining({ spanId: "request", serviceId: "platform" }),
          expect.objectContaining({ spanId: "service-api", serviceId: "api" }),
        ]),
      }),
    );
  });

  it("rejects stale deployment traffic before dependency or trace effects", async () => {
    const fetcher = vi.fn(async () => new Response());
    const recordTrace = vi.fn(async () => undefined);
    const response = await handleHealthApiRequest(
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: {
          "content-type": "application/vnd.regression-surgeon.deployment-health+json",
          "x-deployment-expected-release": "release-new",
        },
        body: JSON.stringify({ interactionId: "deployment-sample" }),
      }),
      {
        fetcher,
        releaseId: "release-old",
        createTraceId: () => "trace-must-not-exist",
        recordTrace,
      },
    );

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: "release-not-ready" } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(recordTrace).not.toHaveBeenCalled();

    const matchingFetcher = vi.fn(async (request: Request) =>
      Response.json({ serviceId: request.headers.get("x-service-id"), status: "healthy" }),
    );
    const matching = await handleHealthApiRequest(
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: {
          "content-type": "application/vnd.regression-surgeon.deployment-health+json",
          "x-deployment-expected-release": "release-new",
        },
        body: JSON.stringify({ interactionId: "deployment-sample" }),
      }),
      {
        fetcher: matchingFetcher,
        releaseId: "release-new",
        createTraceId: () => "trace-new",
      },
    );
    expect(matching.status).toBe(200);
    expect(matchingFetcher).toHaveBeenCalledTimes(3);
  });
});
