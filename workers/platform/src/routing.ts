import { handleHealthApiRequest } from "./api/health-handler";
import { generateRegressionScenario } from "./scenario/generator";
import { handleScenarioRequest } from "./scenario/handler";
import { createTelemetryStore } from "./telemetry/store";
import { handleUxTelemetryRequest } from "./telemetry/ux-handler";

export interface FetchBinding {
  fetch(request: Request): Promise<Response>;
}

export interface PlatformBindings {
  AI?: Ai;
  ASSETS: FetchBinding;
  CF_VERSION_METADATA: { id: string; timestamp?: string };
  GIT_SHA: string;
  GITHUB_OWNER: string;
  GITHUB_REPO: string;
  GITHUB_TOKEN?: string;
  GITHUB_WRITE_ENABLED: string;
  HEALTH_LOADING_MODE: "concurrent" | "sequential";
  HEALTH_SERVICE: FetchBinding;
  MODEL_MODE: string;
  REGRESSION_SURGEON_AGENT: DurableObjectNamespace;
  SCENARIO_CONTROL_ENABLED: string;
  TELEMETRY_DB: D1Database;
}

export type AgentRequestRouter = (
  request: Request,
  bindings: PlatformBindings,
) => Promise<Response | null>;

export async function handlePlatformRequest(
  request: Request,
  bindings: PlatformBindings,
  routeAgent: AgentRequestRouter,
  createTraceId: () => string = () => crypto.randomUUID(),
  telemetryStoreFactory: (
    database: D1Database,
  ) => Pick<
    ReturnType<typeof createTelemetryStore>,
    "recordTrace" | "recordUxEvent"
  > = createTelemetryStore,
  scenarioRequestHandler: typeof handleScenarioRequest = handleScenarioRequest,
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/agents/")) {
    const response = await routeAgent(request, bindings);
    if (response) return response;
    return new Response("Agent route not found", { status: 404 });
  }

  if (url.pathname.startsWith("/api/scenario/")) {
    const store = createTelemetryStore(bindings.TELEMETRY_DB);
    let scenarioTraceSequence = 0;
    return scenarioRequestHandler(request, {
      enabled: bindings.SCENARIO_CONTROL_ENABLED === "true",
      resetScenarioEvidence: store.resetScenarioEvidence,
      generate: (input) =>
        generateRegressionScenario({
          ...input,
          sampleCount: 20,
          fetcher: (healthRequest) => bindings.HEALTH_SERVICE.fetch(healthRequest),
          createTraceId: () => `scenario-trace-${++scenarioTraceSequence}`,
          now: Date.now,
          store,
        }),
      compareReleases: store.compareReleases,
      findSlowTraces: store.findSlowTraces,
      getTraceDetail: store.getTraceDetail,
      investigate: async () => {
        const agent = bindings.REGRESSION_SURGEON_AGENT.getByName(
          "local-e2e-investigation",
        ) as unknown as {
          runLocalInvestigation(): Promise<{ toolTypes: string[]; report: string }>;
        };
        return agent.runLocalInvestigation();
      },
      previewRemediation: async () => {
        const agent = bindings.REGRESSION_SURGEON_AGENT.getByName(
          "local-e2e-investigation",
        ) as unknown as {
          runLocalRemediationPreview(): Promise<unknown>;
        };
        return agent.runLocalRemediationPreview();
      },
    });
  }

  if (url.pathname === "/api/health") {
    const store = telemetryStoreFactory(bindings.TELEMETRY_DB);
    const deployedAtMs = Date.parse(bindings.CF_VERSION_METADATA.timestamp ?? "");
    return handleHealthApiRequest(request, {
      fetcher: (healthRequest) => bindings.HEALTH_SERVICE.fetch(healthRequest),
      releaseId: bindings.CF_VERSION_METADATA.id,
      createTraceId,
      gitSha: bindings.GIT_SHA,
      loadingMode: bindings.HEALTH_LOADING_MODE,
      deployedAtMs: Number.isFinite(deployedAtMs) ? deployedAtMs : 0,
      recordTrace: store.recordTrace,
    });
  }

  if (url.pathname === "/api/telemetry/ux") {
    const store = telemetryStoreFactory(bindings.TELEMETRY_DB);
    return handleUxTelemetryRequest(request, {
      now: Date.now,
      recordUxEvent: store.recordUxEvent,
    });
  }

  if (url.pathname === "/api/runtime") {
    return Response.json({
      mode: bindings.MODEL_MODE,
      versionId: bindings.CF_VERSION_METADATA.id,
      gitSha: bindings.GIT_SHA,
    });
  }

  if (url.pathname === "/app" || url.pathname === "/investigator") {
    return bindings.ASSETS.fetch(request);
  }

  return new Response("Not found", { status: 404 });
}
