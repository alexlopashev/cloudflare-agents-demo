import { describe, expect, it, vi } from "vitest";

import { serviceDefinitions } from "../../packages/contracts/src/health";
import { verifyLocalStack } from "../../scripts/local-stack-contract";

function asRequest(input: string | URL | Request): Request {
  return input instanceof Request ? input : new Request(input);
}

describe("local stack contract", () => {
  it("requires both experiences, the auxiliary service, and runtime metadata", async () => {
    const createInteractionId = vi.fn(() => "e2e-interaction");
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const request = asRequest(input);
      const path = new URL(request.url).pathname;
      if (path === "/app" || path === "/investigator") {
        return new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } });
      }
      if (path === "/api/health") {
        expect(request.method).toBe("POST");
        expect(await request.json()).toEqual({ interactionId: "e2e-interaction" });
        return Response.json({
          interactionId: "e2e-interaction",
          traceId: "e2e-trace",
          releaseId: "local",
          outcome: "healthy",
          services: serviceDefinitions.map((service) => ({ ...service, status: "healthy" })),
        });
      }
      if (path === "/api/telemetry/ux") {
        expect(request.method).toBe("POST");
        expect(await request.json()).toEqual({
          interactionId: "e2e-interaction",
          traceId: "e2e-trace",
          releaseId: "local",
          metricName: "service_grid_ready_ms",
          durationMs: 1,
          outcome: "success",
        });
        return new Response(null, { status: 204 });
      }
      if (path === "/api/runtime") return Response.json({ mode: "fake", versionId: "local" });
      return new Response("Not found", { status: 404 });
    });

    await expect(
      verifyLocalStack("http://127.0.0.1:5173", fetcher, createInteractionId),
    ).resolves.toEqual({
      health: "healthy",
      mode: "fake",
      routes: ["/app", "/investigator"],
      telemetry: "accepted",
    });
    expect(createInteractionId).toHaveBeenCalledOnce();
  });

  it("fails when the service binding does not prove the auxiliary worker responded", async () => {
    const fetcher = vi.fn(async (input: string | URL | Request) => {
      const path = new URL(asRequest(input).url).pathname;
      if (path === "/app" || path === "/investigator") {
        return new Response('<div id="root"></div>', { headers: { "content-type": "text/html" } });
      }
      return Response.json({ outcome: "healthy", services: [] });
    });

    await expect(verifyLocalStack("http://127.0.0.1:5173", fetcher)).rejects.toThrow(
      "health report",
    );
  });
});
