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
  it("gates exact D1 evidence readiness without agent, preview, or write execution", async () => {
    const { bindings } = createBindings();
    const getByName = vi.fn();
    bindings.DEPLOY_SMOKE_KEY = "deployment-smoke-key-123456";
    bindings.REGRESSION_SURGEON_AGENT = { getByName } as unknown as DurableObjectNamespace;
    const compareReleases = vi.fn(async () => ({ status: "ready" as const }));
    const findSlowTraces = vi.fn(async () => [
      {
        traceId: "trace-1",
        interactionId: "interaction-1",
        releaseId: "degraded-version",
        startedAtMs: 1_500,
        durationMs: 400,
        outcome: "success" as const,
      },
    ]);
    const getTraceDetail = vi.fn(async () => ({
      trace: { traceId: "trace-1", releaseId: "degraded-version" },
    }));
    const getReleaseSourceEvidence = vi.fn(
      async () =>
        ({
          releaseId: "degraded-version",
          commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
          commitSubject: "perf: serialize health checks (#19)",
          committedAt: "2026-07-12T01:42:21.000Z",
          pullRequestNumber: 19 as const,
          pullRequestHeadSha: "9af361e5a9420323b2c86f2670e3bf812ac58620" as const,
          sourcePath: "workers/platform/src/api/health.ts",
          blobSha: "a".repeat(40),
          byteLength: 7,
          content: "source\n",
        }) as const,
    );
    const getReleasePreviewEvidence = vi.fn(
      async () =>
        ({
          releaseId: "degraded-version",
          baseSha: bindings.GIT_SHA,
          sourcePath: "workers/platform/src/api/health.ts",
          blobSha: "a".repeat(40),
          byteLength: 7,
          content: "source\n",
        }) as const,
    );
    const evidenceStoreFactory = vi.fn(() => ({
      compareReleases,
      findSlowTraces,
      getTraceDetail,
      getReleaseSourceEvidence,
      getReleasePreviewEvidence,
    }));

    const denied = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-evidence-readiness"),
      bindings,
      async () => null,
      undefined,
      undefined,
      undefined,
      evidenceStoreFactory,
    );
    expect(denied.status).toBe(404);
    expect(evidenceStoreFactory).not.toHaveBeenCalled();

    const wrongMethod = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-evidence-readiness", {
        method: "POST",
        headers: { "x-deploy-smoke-key": "deployment-smoke-key-123456" },
      }),
      bindings,
      async () => null,
      undefined,
      undefined,
      undefined,
      evidenceStoreFactory,
    );
    expect(wrongMethod.status).toBe(405);
    expect(evidenceStoreFactory).not.toHaveBeenCalled();

    const response = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-evidence-readiness", {
        headers: { "x-deploy-smoke-key": "deployment-smoke-key-123456" },
      }),
      bindings,
      async () => null,
      undefined,
      undefined,
      undefined,
      evidenceStoreFactory,
    );
    expect(response.status).toBe(204);
    expect(compareReleases).toHaveBeenCalledWith({
      baselineReleaseId: "baseline-version",
      candidateReleaseId: "degraded-version",
      windowMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(findSlowTraces).toHaveBeenCalledWith({
      releaseId: "degraded-version",
      sinceMs: 1_000,
      untilMs: 2_000,
      limit: 5,
    });
    expect(getTraceDetail).toHaveBeenCalledWith("trace-1");
    expect(getReleasePreviewEvidence).toHaveBeenCalledWith("degraded-version", bindings.GIT_SHA);
    expect(getByName).not.toHaveBeenCalled();
  });

  it("keeps the deployed-agent smoke route keyed and invokes one isolated agent", async () => {
    const { bindings } = createBindings();
    const incident = {
      incidentId: "configured-latency-regression",
      baselineReleaseId: "baseline-version",
      degradedReleaseId: "degraded-version",
      traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
    };
    const commitSha = "a".repeat(40);
    const blobSha = "b".repeat(40);
    const runLocalInvestigation = vi.fn(async () => ({
      incident,
      receipt: {
        investigationId: "investigation-1",
        incident,
        phases: [
          { toolName: "compare_releases", status: "complete" },
          { toolName: "find_slow_traces", status: "complete" },
          { toolName: "inspect_trace", status: "complete" },
          { toolName: "inspect_release", status: "complete" },
          { toolName: "read_repo_files", status: "complete" },
        ],
        evidence: {
          baselineReleaseId: "baseline-version",
          degradedReleaseId: "degraded-version",
          selectedTraceId: "trace-1",
          inspectedTraceId: "trace-1",
          releaseId: "degraded-version",
          commitSha,
          pullRequest: { status: "found", number: 19 },
          sourcePath: "workers/platform/src/api/health.ts",
          blobSha,
        },
      },
      preparedRemediation: {
        fingerprint: "proposal-v1-0123456789abcdef",
        proposal: {
          incident: {
            ...incident,
            traceId: "trace-1",
            regressionCommitSha: commitSha,
            sourcePullRequestNumber: 19,
          },
          expectedBaseSha: commitSha,
          expectedBlobSha: blobSha,
          path: "workers/platform/src/api/health.ts",
        },
        diff: { additions: 4, deletions: 4, path: "workers/platform/src/api/health.ts" },
      },
      report: `## Evidence
investigation-1 configured-latency-regression trace-1 aaaaaaa PR #19
## Inference
Cause.
## Confidence
High.
## Unknowns
None.`,
    }));
    const runLocalRemediationPreview = vi.fn(async () => ({
      branch: "regression-surgeon/0123456789abcdef",
      body: `## Evidence
configured-latency-regression trace-1 ${commitSha} PR #19
## Risk
Bounded.
## Validation
Run gates.`,
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
    expect(await response.json()).toEqual({
      verification: {
        incident,
        investigationId: "investigation-1",
        phases: [
          "compare_releases",
          "find_slow_traces",
          "inspect_trace",
          "inspect_release",
          "read_repo_files",
        ],
        crossReferences: {
          traceId: "trace-1",
          releaseId: "degraded-version",
          commitSha,
          pullRequestNumber: 19,
          sourcePath: "workers/platform/src/api/health.ts",
          blobSha,
        },
        reportSections: ["Evidence", "Inference", "Confidence", "Unknowns"],
        remediation: {
          branch: "regression-surgeon/0123456789abcdef",
          fingerprint: "proposal-v1-0123456789abcdef",
          path: "workers/platform/src/api/health.ts",
          additions: 4,
          deletions: 4,
          status: "preview",
          writesPerformed: false,
        },
      },
    });
    expect(getByName).toHaveBeenCalledExactlyOnceWith("deployment-smoke-1234567890");
    expect(runLocalInvestigation).toHaveBeenCalledOnce();
    expect(runLocalRemediationPreview).toHaveBeenCalledOnce();
  });

  it("stops an incomplete evidence smoke before remediation with bounded phase evidence", async () => {
    const { bindings } = createBindings();
    const incident = {
      incidentId: "configured-latency-regression",
      baselineReleaseId: "baseline-version",
      degradedReleaseId: "degraded-version",
      traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
    };
    const runLocalInvestigation = vi.fn(async () => ({
      incident,
      receipt: {
        investigationId: "investigation-incomplete",
        incident,
        phases: [
          { toolName: "compare_releases", status: "complete", attempts: [] },
          { toolName: "find_slow_traces", status: "complete", attempts: [] },
          { toolName: "inspect_trace", status: "complete", attempts: [] },
          {
            toolName: "inspect_release",
            status: "error",
            attempts: [
              {
                toolCallId: "tool-call-release",
                status: "error",
                reason: "rate-limited",
              },
            ],
          },
          { toolName: "read_repo_files", status: "pending", attempts: [] },
        ],
        processedToolCallIds: ["tool-call-release"],
        evidence: {},
      },
      report: "Model prose must not enter the diagnostic.",
    }));
    const runLocalRemediationPreview = vi.fn(async () => {
      throw new Error("remediation must not run");
    });
    bindings.DEPLOY_SMOKE_KEY = "deployment-smoke-key-123456";
    bindings.REGRESSION_SURGEON_AGENT = {
      getByName: vi.fn(() => ({ runLocalInvestigation, runLocalRemediationPreview })),
    } as unknown as DurableObjectNamespace;

    const response = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-smoke", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-deploy-smoke-key": "deployment-smoke-key-123456",
        },
        body: JSON.stringify({ session: "deployment-smoke-incomplete-123456" }),
      }),
      bindings,
      async () => null,
    );

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({
      error: {
        code: "incomplete-evidence-receipt",
        phases: [
          { toolName: "compare_releases", status: "complete" },
          { toolName: "find_slow_traces", status: "complete" },
          { toolName: "inspect_trace", status: "complete" },
          { toolName: "inspect_release", status: "error", reason: "rate-limited" },
          { toolName: "read_repo_files", status: "pending" },
        ],
      },
    });
    expect(runLocalInvestigation).toHaveBeenCalledOnce();
    expect(runLocalRemediationPreview).not.toHaveBeenCalled();
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

  it("exposes side-effect-free version readiness before incident configuration", async () => {
    const { bindings, recordTrace, recordUxEvent } = createBindings();
    bindings.EVIDENCE_DEGRADED_RELEASE_ID = bindings.EVIDENCE_BASELINE_RELEASE_ID;

    const response = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-readiness"),
      bindings,
      async () => null,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      gitSha: "0123456789abcdef0123456789abcdef01234567",
      versionId: "version-good",
    });
    expect(recordTrace).not.toHaveBeenCalled();
    expect(recordUxEvent).not.toHaveBeenCalled();

    const rejected = await handlePlatformRequest(
      new Request("https://example.test/api/deployment-readiness", { method: "POST" }),
      bindings,
      async () => null,
    );
    expect(rejected.status).toBe(405);
  });

  it.each([
    ["Git SHA", (bindings: PlatformBindings) => (bindings.GIT_SHA = "")],
    [
      "deployment timestamp",
      (bindings: PlatformBindings) => (bindings.CF_VERSION_METADATA.timestamp = "not-a-date"),
    ],
  ])("fails runtime verification closed for an invalid %s", async (_label, invalidate) => {
    const { bindings } = createBindings();
    invalidate(bindings);

    const response = await handlePlatformRequest(
      new Request("https://example.test/api/runtime"),
      bindings,
      async () => null,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: { code: "invalid-runtime-configuration" },
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
