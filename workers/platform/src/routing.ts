import { handleHealthApiRequest } from "./api/health-handler";
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
  HEALTH_SERVICE: FetchBinding;
  MODEL_MODE: string;
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
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/agents/")) {
    const response = await routeAgent(request, bindings);
    if (response) return response;
    return new Response("Agent route not found", { status: 404 });
  }

  if (url.pathname === "/api/health") {
    const store = telemetryStoreFactory(bindings.TELEMETRY_DB);
    const deployedAtMs = Date.parse(bindings.CF_VERSION_METADATA.timestamp ?? "");
    return handleHealthApiRequest(request, {
      fetcher: (healthRequest) => bindings.HEALTH_SERVICE.fetch(healthRequest),
      releaseId: bindings.CF_VERSION_METADATA.id,
      createTraceId,
      gitSha: bindings.GIT_SHA,
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
