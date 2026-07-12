import { z } from "zod";

import { evidenceIdSchema } from "../../../../packages/contracts/src/health";
import type { UxEventRecord } from "./store";

type UxTelemetryOptions = {
  now: () => number;
  recordUxEvent: (event: UxEventRecord) => Promise<void>;
};

const requestSchema = z
  .object({
    interactionId: evidenceIdSchema,
    traceId: evidenceIdSchema,
    releaseId: evidenceIdSchema,
    metricName: z.literal("service_grid_ready_ms"),
    durationMs: z.number().finite().nonnegative(),
    outcome: z.enum(["success", "partial", "error"]),
  })
  .strict();

const bodyLimit = 2_048;

function errorResponse(status: number, code: string, headers: HeadersInit = {}) {
  return Response.json(
    { error: { code, message: "UX telemetry request is invalid." } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

async function readBody(request: Request): Promise<string> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) throw new TypeError("invalid length");
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
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function handleUxTelemetryRequest(
  request: Request,
  options: UxTelemetryOptions,
): Promise<Response> {
  if (request.method !== "POST") {
    return errorResponse(405, "method-not-allowed", { allow: "POST" });
  }
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return errorResponse(415, "unsupported-media-type");
  }

  let text: string;
  try {
    text = await readBody(request);
  } catch (error) {
    return errorResponse(error instanceof RangeError ? 413 : 400, "invalid-request");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return errorResponse(400, "invalid-request");
  }
  const parsed = requestSchema.safeParse(payload);
  const recordedAtMs = options.now();
  if (!parsed.success || !Number.isFinite(recordedAtMs) || recordedAtMs < 0) {
    return errorResponse(400, "invalid-request");
  }

  try {
    await options.recordUxEvent({ ...parsed.data, recordedAtMs });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch {
    return errorResponse(500, "telemetry-unavailable");
  }
}
