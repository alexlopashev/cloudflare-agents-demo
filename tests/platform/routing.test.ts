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
    DEPLOY_SMOKE_KEY: "",
    EVIDENCE_INCIDENT_ID: "configured-latency-regression",
    EVIDENCE_BASELINE_RELEASE_ID: "baseline-version",
    EVIDENCE_DEGRADED_RELEASE_ID: "degraded-version",
    EVIDENCE_DEGRADED_SINCE_MS: "1000",
    EVIDENCE_DEGRADED_UNTIL_MS: "2000",
    GIT_SHA: "0123456789abcdef0123456789abcdef01234567",
    GITHUB_OWNER: "alexlopashev",
    GITHUB_REPO: "cloudflare-agents-demo",
    GITHUB_WRITE_ENABLED: "false",
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
  it("keeps the deployed-agent smoke route keyed and invokes one isolated agent", async () => {
    const { bindings } = createBindings();
    const runLocalInvestigation = vi.fn(async () => ({
      toolTypes: ["tool-query_telemetry"],
      report: "Evidence Inference Confidence Unknowns",
    }));
    const runLocalRemediationPreview = vi.fn(async () => ({
      status: "preview",
      writesPerformed: false,
    }));
    const getByName = vi.fn(() => ({ runLocalInvestigation, runLocalRemediationPreview }));
    bindings.DEPLOY_SMOKE_KEY = "deployment-smoke-key-123456";
    bindings.REGRESSION_SURGEON_AGENT = { getByName } as unknown as DurableObjectNamespace;

    const denied = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-smoke", { method: "POST" }),
      bindings,
      async () => null,
    );
    expect(denied.status).toBe(404);

    const response = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-smoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-deploy-smoke-key": "deployment-smoke-key-123456",
        },
        body: JSON.stringify({ session: "deployment-smoke-1234567890" }),
      }),
      bindings,
      async () => null,
    );
    expect(response.status).toBe(200);
    expect(getByName).toHaveBeenCalledExactlyOnceWith("deployment-smoke-1234567890");
    expect(runLocalInvestigation).toHaveBeenCalledOnce();
    expect(runLocalRemediationPreview).toHaveBeenCalledOnce();
  });

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
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-version",
        degradedReleaseId: "degraded-version",
        traceWindow: { sinceMs: 1000, untilMs: 2000 },
      },
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      githubWriteEnabled: false,
      mode: "fake",
      versionId: "version-good",
    });
  });

  it("fails the runtime verification surface closed for an invalid incident", async () => {
    const { bindings } = createBindings();
    bindings.EVIDENCE_DEGRADED_RELEASE_ID = bindings.EVIDENCE_BASELINE_RELEASE_ID;

    const response = await handlePlatformRequest(
      new Request("https://example.test/api/runtime"),
      bindings,
      async () => null,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "invalid-incident-configuration" },
    });
  });

  it("records current-release telemetry without changing the configured incident", async () => {
    const { bindings, telemetryStoreFactory } = createBindings();
    const before = await handlePlatformRequest(
      new Request("https://example.test/api/runtime"),
      bindings,
      async () => null,
    );
    const generated = await handlePlatformRequest(
      new Request("https://example.test/api/telemetry/ux", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          interactionId: "generated-interaction",
          traceId: "generated-trace",
          releaseId: "current-release",
          metricName: "service_grid_ready_ms",
          durationMs: 123,
          outcome: "success",
        }),
      }),
      bindings,
      async () => null,
      undefined,
      telemetryStoreFactory,
    );
    const after = await handlePlatformRequest(
      new Request("https://example.test/api/runtime"),
      bindings,
      async () => null,
    );

    expect(generated.status).toBe(204);
    expect(await after.json()).toEqual(await before.json());
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
