import { evidenceIdSchema } from "../../../../packages/contracts/src/health";
import { createHealthAggregator } from "./health";
import type { SpanRecord, TraceRecord } from "../telemetry/store";

type Fetcher = (request: Request) => Promise<Response>;

export type HealthApiOptions = {
  fetcher: Fetcher;
  releaseId: string;
  createTraceId: () => string;
  gitSha?: string;
  deployedAtMs?: number;
  now?: () => number;
  recordTrace?: (input: {
    release: { releaseId: string; gitSha: string; deployedAtMs: number };
    trace: TraceRecord;
    spans: readonly SpanRecord[];
  }) => Promise<void>;
};

const bodyLimit = 2_048;

function errorResponse(status: number, code: string, message: string, headers: HeadersInit = {}) {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

async function readBoundedBody(request: Request): Promise<string | null> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) return null;
    if (Number.parseInt(declaredLength, 10) > bodyLimit) throw new RangeError("body too large");
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    byteLength += result.value.byteLength;
    if (byteLength > bodyLimit) {
      await reader.cancel();
      throw new RangeError("body too large");
    }
    chunks.push(result.value);
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
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
  if (mediaType !== "application/json") {
    return errorResponse(415, "unsupported-media-type", "Use an application/json request body.");
  }

  let text: string | null;
  try {
    text = await readBoundedBody(request);
  } catch (error) {
    if (error instanceof RangeError) {
      return errorResponse(413, "request-too-large", "Health refresh request is too large.");
    }
    return errorResponse(400, "invalid-request", "Health refresh request is invalid.");
  }
  if (text === null) {
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

  try {
    const now = options.now ?? Date.now;
    const startedAtMs = now();
    const spans: SpanRecord[] = [];
    const report = await createHealthAggregator({
      fetcher: options.fetcher,
      createTraceId: options.createTraceId,
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
