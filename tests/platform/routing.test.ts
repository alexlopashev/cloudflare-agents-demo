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
  const recordTrace = vi.fn(async () => undefined);
  const recordUxEvent = vi.fn(async () => undefined);
  const telemetryStoreFactory = vi.fn(() => ({ recordTrace, recordUxEvent }));
  const bindings = {
    AI: {},
    ASSETS: { fetch: assetFetch },
    CF_VERSION_METADATA: {
      id: "version-good",
      timestamp: "2026-07-11T12:00:00.000Z",
    },
    GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_OWNER: "alexlopashev",
    GITHUB_REPO: "cloudflare-agents-demo",
    HEALTH_SERVICE: { fetch: healthFetch },
    HEALTH_LOADING_MODE: "sequential",
    MODEL_MODE: "fake",
    SCENARIO_CONTROL_ENABLED: "false",
    TELEMETRY_DB: {},
  } as unknown as PlatformBindings;

  return {
    assetFetch,
    bindings,
    healthFetch,
    recordTrace,
    recordUxEvent,
    telemetryStoreFactory,
  };
}

describe("platform routing", () => {
  it("delegates health requests to the auxiliary Worker binding", async () => {
    const { bindings, healthFetch, recordTrace, telemetryStoreFactory } = createBindings();
    const response = await handlePlatformRequest(
      new Request("https://example.test/api/health", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: "interaction-1" }),
      }),
      bindings,
      async () => null,
      () => "trace-1",
      telemetryStoreFactory,
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
    expect(recordTrace).toHaveBeenCalledOnce();
    expect(recordTrace).toHaveBeenCalledWith(
      expect.objectContaining({
        release: {
          releaseId: "version-good",
          gitSha: "0123456789abcdef0123456789abcdef01234567",
          deployedAtMs: Date.parse("2026-07-11T12:00:00.000Z"),
        },
      }),
    );
  });

  it("persists the fixed UX telemetry contract through D1", async () => {
    const { bindings, recordUxEvent, telemetryStoreFactory } = createBindings();
    const response = await handlePlatformRequest(
      new Request("https://example.test/api/telemetry/ux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interactionId: "interaction-1",
          traceId: "trace-1",
          releaseId: "version-good",
          metricName: "service_grid_ready_ms",
          durationMs: 125,
          outcome: "success",
        }),
      }),
      bindings,
      async () => null,
      () => "unused-trace",
      telemetryStoreFactory,
    );

    expect(response.status).toBe(204);
    expect(recordUxEvent).toHaveBeenCalledOnce();
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

    expect(await response.json()).toEqual({
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      mode: "fake",
      versionId: "version-good",
    });
  });

  it("routes scenario controls through their local-only boundary", async () => {
    const { bindings } = createBindings();
    bindings.SCENARIO_CONTROL_ENABLED = "true";
    const scenarioHandler = vi.fn(
      async (_request: Request, _options: unknown) => new Response(null, { status: 204 }),
    );
    const response = await handlePlatformRequest(
      new Request("http://localhost/api/scenario/reset", {
        method: "POST",
        headers: { "x-local-scenario-key": "regression-surgeon-local-only" },
      }),
      bindings,
      async () => null,
      undefined,
      undefined,
      scenarioHandler,
    );

    expect(response.status).toBe(204);
    expect(scenarioHandler).toHaveBeenCalledOnce();
    expect(scenarioHandler.mock.calls[0]?.[1]).toMatchObject({ enabled: true });
  });
});
