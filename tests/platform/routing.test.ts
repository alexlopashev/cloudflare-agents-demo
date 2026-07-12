import { describe, expect, it, vi } from "vitest";

import { handlePlatformRequest, type PlatformBindings } from "../../workers/platform/src/routing";

function createBindings() {
  const healthFetch = vi.fn(async (request: Request) => {
    return Response.json({
      serviceId: request.headers.get("x-service-id"),
      status: "healthy",
    });
  });
  const assetFetch = vi.fn(async (request: Request) =>
    Response.json({ path: new URL(request.url).pathname }),
  );
  const bindings = {
    AI: {},
    ASSETS: { fetch: assetFetch },
    CF_VERSION_METADATA: { id: "version-good" },
    HEALTH_SERVICE: { fetch: healthFetch },
    MODEL_MODE: "fake",
  } as unknown as PlatformBindings;

  return { assetFetch, bindings, healthFetch };
}

describe("platform routing", () => {
  it("delegates health requests to the auxiliary Worker binding", async () => {
    const { bindings, healthFetch } = createBindings();
    const response = await handlePlatformRequest(
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: "interaction-1" }),
      }),
      bindings,
      async () => null,
      () => "trace-1",
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      interactionId: "interaction-1",
      traceId: "trace-1",
      releaseId: "version-good",
      outcome: "healthy",
    });
    expect(healthFetch).toHaveBeenCalledTimes(3);
    expect(healthFetch.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      "/health/api",
      "/health/jobs",
      "/health/storage",
    ]);
  });

  it.each(["/app", "/investigator"])("serves %s through the asset binding", async (path) => {
    const { assetFetch, bindings } = createBindings();
    const response = await handlePlatformRequest(
      new Request(`https://example.test${path}`),
      bindings,
      async () => null,
    );

    expect(await response.json()).toEqual({ path });
    expect(assetFetch).toHaveBeenCalledOnce();
  });

  it("gives the Agents protocol ownership of /agents routes", async () => {
    const { assetFetch, bindings, healthFetch } = createBindings();
    const agentResponse = new Response("agent-route");
    const routeAgent = vi.fn(async () => agentResponse);

    const response = await handlePlatformRequest(
      new Request("https://example.test/agents/regression-surgeon/session"),
      bindings,
      routeAgent,
    );

    expect(response).toBe(agentResponse);
    expect(routeAgent).toHaveBeenCalledOnce();
    expect(assetFetch).not.toHaveBeenCalled();
    expect(healthFetch).not.toHaveBeenCalled();
  });

  it("reports runtime mode and immutable version metadata", async () => {
    const { bindings } = createBindings();
    const response = await handlePlatformRequest(
      new Request("https://example.test/api/runtime"),
      bindings,
      async () => null,
    );

    expect(await response.json()).toEqual({ mode: "fake", versionId: "version-good" });
  });
});
