import {
  configuredIncidentReference,
  type IncidentEnvironment,
  type IncidentReference,
} from "../../../packages/contracts/src/incident";
import { handleHealthApiRequest } from "./api/health-handler";
import { composeExternalConfiguration } from "./config";
import { generateRegressionScenario } from "./scenario/generator";
import { handleScenarioRequest } from "./scenario/handler";
import { createTelemetryStore } from "./telemetry/store";
import { handleUxTelemetryRequest } from "./telemetry/ux-handler";

export interface FetchBinding {
  fetch(request: Request): Promise<Response>;
}

export interface PlatformBindings extends IncidentEnvironment {
  AI?: Ai;
  ASSETS: FetchBinding;
  CF_VERSION_METADATA: { id: string; timestamp?: string };
  DEPLOY_SMOKE_KEY?: string;
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
  let externalConfiguration: ReturnType<typeof composeExternalConfiguration>;
  try {
    externalConfiguration = composeExternalConfiguration({
      versionMetadata: bindings.CF_VERSION_METADATA,
      gitSha: bindings.GIT_SHA,
      githubOwner: bindings.GITHUB_OWNER,
      githubRepo: bindings.GITHUB_REPO,
      ...(bindings.GITHUB_TOKEN === undefined ? {} : { githubToken: bindings.GITHUB_TOKEN }),
      githubWriteEnabled: bindings.GITHUB_WRITE_ENABLED,
      modelMode: bindings.MODEL_MODE,
    });
  } catch {
    return Response.json({ error: { code: "invalid-runtime-configuration" } }, { status: 503 });
  }

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
          runLocalInvestigation(): Promise<{
            incident: IncidentReference;
            toolTypes: string[];
            report: string;
          }>;
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
    return handleHealthApiRequest(request, {
      fetcher: (healthRequest) => bindings.HEALTH_SERVICE.fetch(healthRequest),
      releaseId: externalConfiguration.runtime.versionId,
      createTraceId,
      gitSha: externalConfiguration.runtime.gitSha,
      loadingMode: bindings.HEALTH_LOADING_MODE,
      deployedAtMs: externalConfiguration.runtime.deployedAtMs,
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
    let incident: IncidentReference;
    try {
      incident = configuredIncidentReference(bindings);
    } catch {
      return Response.json({ error: { code: "invalid-incident-configuration" } }, { status: 503 });
    }
    return Response.json({
      mode: externalConfiguration.modelMode,
      versionId: externalConfiguration.runtime.versionId,
      gitSha: externalConfiguration.runtime.gitSha,
      incident,
      githubWriteEnabled: externalConfiguration.github.writeEnabled,
    });
  }

  if (url.pathname === "/api/deployment-smoke") {
    if (
      request.method !== "POST" ||
      bindings.DEPLOY_SMOKE_KEY === undefined ||
      bindings.DEPLOY_SMOKE_KEY.length < 20 ||
      request.headers.get("x-deploy-smoke-key") !== bindings.DEPLOY_SMOKE_KEY
    ) {
      return Response.json({ error: { code: "not-found" } }, { status: 404 });
    }
    let session: unknown;
    try {
      const body = (await request.json()) as { session?: unknown };
      session = body.session;
    } catch {
      return Response.json({ error: { code: "invalid-request" } }, { status: 400 });
    }
    if (typeof session !== "string" || !/^deployment-smoke-[A-Za-z0-9-]{10,100}$/.test(session)) {
      return Response.json({ error: { code: "invalid-request" } }, { status: 400 });
    }
    const agent = bindings.REGRESSION_SURGEON_AGENT.getByName(session) as unknown as {
      runLocalInvestigation(): Promise<{
        incident: IncidentReference;
        toolTypes: string[];
        report: string;
      }>;
      runLocalRemediationPreview(): Promise<unknown>;
    };
    const investigation = await agent.runLocalInvestigation();
    const remediation = await agent.runLocalRemediationPreview();
    return Response.json({ investigation, remediation });
  }

  if (url.pathname === "/app" || url.pathname === "/investigator") {
    return bindings.ASSETS.fetch(request);
  }

  return new Response("Not found", { status: 404 });
}
