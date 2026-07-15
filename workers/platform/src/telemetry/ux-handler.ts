import { z } from "zod";

import { evidenceIdSchema } from "../../../../packages/contracts/src/health";
import { readBoundedRequestText } from "../http/bounded-request";
import {
  checkPublicUsage,
  publicUsageDenialMessage,
  type PublicUsageOptions,
} from "../public-usage";
import type { UxEventRecord } from "./store";

type UxTelemetryOptions = {
  now: () => number;
  recordUxEvent: (event: UxEventRecord) => Promise<void>;
  publicUsage?: PublicUsageOptions;
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
    text = await readBoundedRequestText(request, bodyLimit);
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

  if (options.publicUsage !== undefined) {
    const decision = await checkPublicUsage(options.publicUsage.mode, options.publicUsage.limiter);
    if (!decision.allowed) {
      return Response.json(
        {
          error: {
            code: decision.code,
            message: publicUsageDenialMessage(decision, "Public metric traffic"),
          },
        },
        {
          status: decision.status,
          headers: {
            "cache-control": "no-store",
            ...(decision.retryAfterSeconds === undefined
              ? {}
              : { "retry-after": String(decision.retryAfterSeconds) }),
          },
        },
      );
    }
  }

  try {
    await options.recordUxEvent({ ...parsed.data, recordedAtMs });
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  } catch {
    return errorResponse(500, "telemetry-unavailable");
  }
}
