import { isServiceId } from "../../../packages/contracts/src/services";

export const CONTROLLED_HEALTH_DELAY_MS = 120;

type HealthServiceOptions = {
  wait: (delayMs: number) => Promise<void>;
};

export function createHealthService(options: HealthServiceOptions) {
  return {
    async fetch(request: Request): Promise<Response> {
      if (request.method !== "GET") {
        return Response.json(
          { error: { code: "method-not-allowed", message: "Use GET for service health." } },
          { status: 405, headers: { allow: "GET", "cache-control": "no-store" } },
        );
      }
      const match = /^\/health\/([^/]+)$/.exec(new URL(request.url).pathname);
      if (!match) return new Response("Not found", { status: 404 });

      let candidate: string;
      try {
        candidate = decodeURIComponent(match[1] ?? "");
      } catch {
        return new Response("Not found", { status: 404 });
      }
      if (!isServiceId(candidate)) return new Response("Not found", { status: 404 });

      await options.wait(CONTROLLED_HEALTH_DELAY_MS);
      return Response.json(
        { serviceId: candidate, status: "healthy" },
        { headers: { "cache-control": "no-store" } },
      );
    },
  };
}

const healthService = createHealthService({
  wait: async (delayMs) => scheduler.wait(delayMs),
}) satisfies ExportedHandler;

export default healthService;
