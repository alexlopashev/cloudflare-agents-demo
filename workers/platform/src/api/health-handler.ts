import { evidenceIdSchema } from "../../../../packages/contracts/src/health";
import { readBoundedRequestText } from "../http/bounded-request";
import {
  checkPublicUsage,
  publicUsageDenialMessage,
  type PublicUsageOptions,
} from "../public-usage";
import { createHealthAggregator, type HealthLoadingMode } from "./health";
import type { SpanRecord, TraceRecord } from "../telemetry/store";

type Fetcher = (request: Request) => Promise<Response>;

export type HealthApiOptions = {
  fetcher: Fetcher;
  releaseId: string;
  createTraceId: () => string;
  loadingMode?: HealthLoadingMode;
  gitSha?: string;
  deployedAtMs?: number;
  now?: () => number;
  recordTrace?: (input: {
    release: { releaseId: string; gitSha: string; deployedAtMs: number };
    trace: TraceRecord;
    spans: readonly SpanRecord[];
  }) => Promise<void>;
  publicUsage?: PublicUsageOptions;
};

const bodyLimit = 2_048;
const deploymentHealthMediaType = "application/vnd.regression-surgeon.deployment-health+json";

function errorResponse(status: number, code: string, message: string, headers: HeadersInit = {}) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

export async function handleHealthApiRequest(
  request: Request,
  options: HealthApiOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "method-not-allowed", "Use POST for a health refresh.", {
      allow: "POST",
    });
  }
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  const expectedRelease = request.headers.get("x-deployment-expected-release");
  const expectedMediaType =
    expectedRelease === null ? "application/json" : deploymentHealthMediaType;
  if (mediaType !== expectedMediaType) {
    return errorResponse(415, "unsupported-media-type", "Use an application/json request body.");
  }
  if (expectedRelease !== null) {
    const parsedExpectedRelease = evidenceIdSchema.safeParse(expectedRelease);
    if (!parsedExpectedRelease.success) {
      return errorResponse(400, "invalid-expected-release", "Expected release is invalid.");
    }
    if (parsedExpectedRelease.data !== options.releaseId) {
      return errorResponse(409, "release-not-ready", "Expected release has not reached this edge.");
    }
  }

  let text: string;
  try {
    text = await readBoundedRequestText(request, bodyLimit);
  } catch (error) {
    if (error instanceof RangeError) {
      return errorResponse(413, "request-too-large", "Health refresh request is too large.");
    }
    return errorResponse(400, "invalid-request", "Health refresh request is invalid.");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return errorResponse(400, "invalid-request", "Health refresh request is invalid.");
  }
  const parsed = evidenceIdSchema.safeParse(
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? Reflect.get(payload, "interactionId")
      : undefined,
  );
  if (!parsed.success) {
    return errorResponse(400, "invalid-interaction-id", "Interaction identifier is invalid.");
  }

  if (expectedRelease === null && options.publicUsage !== undefined) {
    const decision = await checkPublicUsage(options.publicUsage.mode, options.publicUsage.limiter);
    if (!decision.allowed) {
      return errorResponse(
        decision.status,
        decision.code,
        publicUsageDenialMessage(decision, "Public metric traffic"),
        decision.retryAfterSeconds === undefined
          ? {}
          : { "retry-after": String(decision.retryAfterSeconds) },
      );
    }
  }

  try {
    const now = options.now ?? Date.now;
    const startedAtMs = now();
    const spans: SpanRecord[] = [];
    const report = await createHealthAggregator({
      fetcher: options.fetcher,
      createTraceId: options.createTraceId,
      ...(options.loadingMode === undefined ? {} : { loadingMode: options.loadingMode }),
      now,
      observeSpan: (span) => spans.push(span),
    }).collect({ interactionId: parsed.data, releaseId: options.releaseId });
    const endedAtMs = now();
    const outcome =
      report.outcome === "healthy" ? "success" : report.outcome === "partial" ? "partial" : "error";
    if (options.recordTrace) {
      await options.recordTrace({
        release: {
          releaseId: report.releaseId,
          gitSha: options.gitSha ?? "",
          deployedAtMs: options.deployedAtMs ?? 0,
        },
        trace: {
          traceId: report.traceId,
          interactionId: report.interactionId,
          releaseId: report.releaseId,
          startedAtMs,
          durationMs: Math.max(0, endedAtMs - startedAtMs),
          outcome,
        },
        spans: [
          {
            traceId: report.traceId,
            spanId: "request",
            parentSpanId: null,
            serviceId: "platform",
            startedAtMs,
            durationMs: Math.max(0, endedAtMs - startedAtMs),
            status: outcome === "error" ? "error" : "success",
          },
          ...spans,
        ],
      });
    }
    return Response.json(report, { headers: { "cache-control": "no-store" } });
  } catch {
    return errorResponse(500, "health-unavailable", "Health report could not be created.");
  }
}
