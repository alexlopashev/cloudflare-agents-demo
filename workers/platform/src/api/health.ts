import {
  dependencyHealthResponseSchema,
  evidenceIdSchema,
  serviceDefinitions,
  type HealthReport,
  type ServiceHealthResult,
} from "../../../../packages/contracts/src/health";
import type { SpanRecord } from "../telemetry/store";

type Fetcher = (request: Request) => Promise<Response>;
export type HealthLoadingMode = "concurrent" | "sequential";

export type HealthAggregatorOptions = {
  fetcher: Fetcher;
  createTraceId: () => string;
  loadingMode?: HealthLoadingMode;
  now?: () => number;
  observeSpan?: (span: SpanRecord) => void;
};

export class HealthAggregationError extends Error {
  readonly code: "invalid-input";

  constructor(message: string) {
    super(message);
    this.name = "HealthAggregationError";
    this.code = "invalid-input";
  }
}

export function createHealthAggregator(options: HealthAggregatorOptions) {
  return {
    async collect(input: { interactionId: string; releaseId: string }): Promise<HealthReport> {
      const interactionId = evidenceIdSchema.safeParse(input.interactionId);
      const releaseId = evidenceIdSchema.safeParse(input.releaseId);
      const traceId = evidenceIdSchema.safeParse(options.createTraceId());
      if (!interactionId.success || !releaseId.success || !traceId.success) {
        throw new HealthAggregationError("Health evidence identifiers are invalid.");
      }

      const loadService = async (
        service: (typeof serviceDefinitions)[number],
      ): Promise<ServiceHealthResult> => {
        const startedAtMs = (options.now ?? Date.now)();
        let spanStatus: SpanRecord["status"] = "error";
        const unavailable = {
          ...service,
          status: "unavailable" as const,
          error: {
            code: "dependency-unavailable" as const,
            message: "Health check unavailable." as const,
          },
        };
        try {
          const request = new Request(`https://health-service/health/${service.id}`, {
            headers: {
              "x-interaction-id": interactionId.data,
              "x-service-id": service.id,
              "x-trace-id": traceId.data,
            },
          });
          const response = await options.fetcher(request);
          if (!response.ok) return unavailable;
          const text = await response.text();
          if (new TextEncoder().encode(text).byteLength > 1_024) return unavailable;
          let payload: unknown;
          try {
            payload = JSON.parse(text) as unknown;
          } catch {
            return unavailable;
          }
          const health = dependencyHealthResponseSchema.safeParse(payload);
          if (!health.success || health.data.serviceId !== service.id) return unavailable;
          spanStatus = "success";
          return { ...service, status: "healthy" };
        } catch {
          return unavailable;
        } finally {
          const endedAtMs = (options.now ?? Date.now)();
          try {
            options.observeSpan?.({
              traceId: traceId.data,
              spanId: `service-${service.id}`,
              parentSpanId: "request",
              serviceId: service.id,
              startedAtMs,
              durationMs: Math.max(0, endedAtMs - startedAtMs),
              status: spanStatus,
            });
          } catch {
            // Instrumentation observers cannot alter the health result.
          }
        }
      };
      const services: ServiceHealthResult[] = [];
      if (options.loadingMode === "sequential") {
        for (const service of serviceDefinitions) services.push(await loadService(service));
      } else {
        services.push(...(await Promise.all(serviceDefinitions.map(loadService))));
      }
      const healthyCount = services.filter((service) => service.status === "healthy").length;
      const outcome =
        healthyCount === services.length ? "healthy" : healthyCount === 0 ? "failed" : "partial";
      return {
        interactionId: interactionId.data,
        traceId: traceId.data,
        releaseId: releaseId.data,
        outcome,
        services,
      };
    },
  };
}
