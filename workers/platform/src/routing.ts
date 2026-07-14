import {
  configuredIncidentReference,
  type IncidentEnvironment,
  type IncidentReference,
} from "../../../packages/contracts/src/incident";
import type {
  ReleasePreviewEvidence,
  ReleaseSourceEvidence,
} from "../../../packages/contracts/src/source-evidence";
import { handleHealthApiRequest } from "./api/health-handler";
import { composeExternalConfiguration } from "./config";
import { configuredComparisonWindowMs, configuredSlowTraceLimit } from "./agent/evidence-policy";
import { generateRegressionScenario } from "./scenario/generator";
import { RemediationError } from "./remediation/service";
import { handleScenarioRequest } from "./scenario/handler";
import { createTelemetryStore } from "./telemetry/store";
import {
  createSmokeEvidenceDiagnostic,
  smokeRemediationFailureReasonSchema,
  createSmokeVerificationReceipt,
} from "./verification/smoke-contract";
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

type EvidenceReadinessStore = {
  compareReleases(input: {
    baselineReleaseId: string;
    candidateReleaseId: string;
    windowMs: number;
  }): Promise<{ status: string }>;
  findSlowTraces(input: {
    releaseId: string;
    sinceMs: number;
    untilMs: number;
    limit: number;
  }): Promise<readonly { traceId: string; releaseId: string }[]>;
  getTraceDetail(traceId: string): Promise<{
    trace: { traceId: string; releaseId: string };
  } | null>;
  getReleaseSourceEvidence(releaseId: string): Promise<ReleaseSourceEvidence | null>;
  getReleasePreviewEvidence(
    releaseId: string,
    baseSha: string,
  ): Promise<ReleasePreviewEvidence | null>;
};

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
  evidenceStoreFactory: (database: D1Database) => EvidenceReadinessStore = createTelemetryStore,
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

  if (url.pathname === "/api/deployment-readiness") {
    if (request.method !== "GET") {
      return Response.json(
        { error: { code: "method-not-allowed" } },
        { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
      );
    }
    return Response.json(
      {
        versionId: externalConfiguration.runtime.versionId,
        gitSha: externalConfiguration.runtime.gitSha,
      },
      { headers: { "cache-control": "no-store" } },
    );
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

  if (url.pathname === "/api/deployment-evidence-readiness") {
    if (
      bindings.DEPLOY_SMOKE_KEY === undefined ||
      bindings.DEPLOY_SMOKE_KEY.length < 20 ||
      request.headers.get("x-deploy-smoke-key") !== bindings.DEPLOY_SMOKE_KEY
    ) {
      return Response.json({ error: { code: "not-found" } }, { status: 404 });
    }
    if (request.method !== "GET") {
      return Response.json(
        { error: { code: "method-not-allowed" } },
        { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
      );
    }
    try {
      const incident = configuredIncidentReference(bindings);
      const store = evidenceStoreFactory(bindings.TELEMETRY_DB);
      const [comparison, traces, source, preview] = await Promise.all([
        store.compareReleases({
          baselineReleaseId: incident.baselineReleaseId,
          candidateReleaseId: incident.degradedReleaseId,
          windowMs: configuredComparisonWindowMs,
        }),
        store.findSlowTraces({
          releaseId: incident.degradedReleaseId,
          sinceMs: incident.traceWindow.sinceMs,
          untilMs: incident.traceWindow.untilMs,
          limit: configuredSlowTraceLimit,
        }),
        store.getReleaseSourceEvidence(incident.degradedReleaseId),
        store.getReleasePreviewEvidence(incident.degradedReleaseId, bindings.GIT_SHA),
      ]);
      const selectedTrace = traces[0];
      if (
        comparison.status !== "ready" ||
        selectedTrace === undefined ||
        selectedTrace.releaseId !== incident.degradedReleaseId ||
        source === null ||
        preview === null ||
        source.releaseId !== incident.degradedReleaseId ||
        preview.releaseId !== incident.degradedReleaseId ||
        preview.baseSha !== bindings.GIT_SHA ||
        source.sourcePath !== preview.sourcePath ||
        source.blobSha !== preview.blobSha ||
        source.byteLength !== preview.byteLength ||
        source.content !== preview.content
      ) {
        throw new TypeError("Configured deployment evidence is incomplete.");
      }
      const detail = await store.getTraceDetail(selectedTrace.traceId);
      if (
        detail === null ||
        detail.trace.traceId !== selectedTrace.traceId ||
        detail.trace.releaseId !== incident.degradedReleaseId
      ) {
        throw new TypeError("Configured deployment trace evidence is incomplete.");
      }
      return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
    } catch {
      return Response.json(
        { error: { code: "evidence-not-ready" } },
        { status: 503, headers: { "cache-control": "no-store" } },
      );
    }
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
      runLocalInvestigation(): Promise<unknown>;
      runLocalRemediationPreview(): Promise<unknown>;
    };
    const investigation = await agent.runLocalInvestigation();
    const diagnostic = createSmokeEvidenceDiagnostic(investigation);
    if (diagnostic !== undefined) return Response.json(diagnostic, { status: 422 });
    let remediation: unknown;
    try {
      remediation = await agent.runLocalRemediationPreview();
    } catch (error) {
      const parsedReason = smokeRemediationFailureReasonSchema.safeParse(
        error instanceof RemediationError ? error.code : "unavailable",
      );
      return Response.json(
        {
          error: {
            code: "remediation-preview-failed",
            reason: parsedReason.success ? parsedReason.data : "unavailable",
          },
        },
        { status: 502 },
      );
    }
    let verification: ReturnType<typeof createSmokeVerificationReceipt>;
    try {
      verification = createSmokeVerificationReceipt({ investigation, remediation });
    } catch {
      return Response.json({ error: { code: "invalid-smoke-verification" } }, { status: 422 });
    }
    return Response.json({ verification });
  }

  if (url.pathname === "/app" || url.pathname === "/investigator") {
    return bindings.ASSETS.fetch(request);
  }

  return new Response("Not found", { status: 404 });
}
