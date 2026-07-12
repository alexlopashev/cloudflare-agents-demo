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
});
