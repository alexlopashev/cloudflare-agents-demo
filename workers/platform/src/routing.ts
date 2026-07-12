export interface FetchBinding {
  fetch(request: Request): Promise<Response>;
}

export interface PlatformBindings {
  AI?: Ai;
  ASSETS: FetchBinding;
  CF_VERSION_METADATA: { id: string };
  HEALTH_SERVICE: FetchBinding;
  MODEL_MODE: string;
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
): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname.startsWith("/agents/")) {
    const response = await routeAgent(request, bindings);
    if (response) return response;
    return new Response("Agent route not found", { status: 404 });
  }

  if (url.pathname === "/api/health") {
    return handleHealthApiRequest(request, {
      fetcher: (healthRequest) => bindings.HEALTH_SERVICE.fetch(healthRequest),
      releaseId: bindings.CF_VERSION_METADATA.id,
      createTraceId,
    });
  }

  if (url.pathname === "/api/runtime") {
    return Response.json({
      mode: bindings.MODEL_MODE,
      versionId: bindings.CF_VERSION_METADATA.id,
    });
  }

  if (url.pathname === "/app" || url.pathname === "/investigator") {
    return bindings.ASSETS.fetch(request);
  }

  return new Response("Not found", { status: 404 });
}
import { handleHealthApiRequest } from "./api/health-handler";
