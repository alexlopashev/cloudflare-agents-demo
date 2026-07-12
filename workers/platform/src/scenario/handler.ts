import { z } from "zod";

import { baselineDeployedAtMs, degradedDeployedAtMs, scenarioReleaseIds } from "./generator";

export const scenarioLocalKey = "regression-surgeon-local-only";

export type ScenarioControlOptions = {
  enabled: boolean;
  resetScenarioEvidence(releaseIds: readonly string[]): Promise<void>;
  generate(input: { goodGitSha: string; badGitSha: string }): Promise<{
    baselineReleaseId: (typeof scenarioReleaseIds)[0];
    degradedReleaseId: (typeof scenarioReleaseIds)[1];
    sampleCount: number;
  }>;
  compareReleases(input: {
    baselineReleaseId: string;
    candidateReleaseId: string;
    windowMs: number;
  }): Promise<unknown>;
  findSlowTraces(input: {
    releaseId?: string;
    sinceMs: number;
    untilMs: number;
    limit: number;
  }): Promise<
    {
      traceId: string;
      releaseId: string;
      durationMs: number;
    }[]
  >;
  getTraceDetail(traceId: string): Promise<{
    criticalPath: { durationMs: number; spanIds: string[] };
  } | null>;
  investigate(): Promise<unknown>;
};

const seedSchema = z
  .object({
    goodGitSha: z.string().regex(/^[0-9a-f]{40}$/),
    badGitSha: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict();
const bodyLimit = 1_024;

function hiddenResponse() {
  return new Response("Not found", { status: 404 });
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) throw new TypeError("invalid length");
    if (Number.parseInt(declaredLength, 10) > bodyLimit) throw new RangeError("body too large");
  }
  if (request.body === null) throw new TypeError("missing body");
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
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
}

export async function handleScenarioRequest(
  request: Request,
  options: ScenarioControlOptions,
): Promise<Response> {
  const url = new URL(request.url);
  const isLoopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (
    !options.enabled ||
    !isLoopback ||
    request.headers.get("x-local-scenario-key") !== scenarioLocalKey
  ) {
    return hiddenResponse();
  }
  const path = url.pathname;
  if (request.method !== "POST") return hiddenResponse();

  if (path === "/api/scenario/reset") {
    await options.resetScenarioEvidence(scenarioReleaseIds);
    return new Response(null, { status: 204, headers: { "cache-control": "no-store" } });
  }
  if (path === "/api/scenario/investigate") {
    return Response.json(await options.investigate(), {
      headers: { "cache-control": "no-store" },
    });
  }
  if (path !== "/api/scenario/reseed") return hiddenResponse();
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return Response.json({ error: { code: "invalid-request" } }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = await readBoundedJson(request);
  } catch {
    return Response.json({ error: { code: "invalid-request" } }, { status: 400 });
  }
  const parsed = seedSchema.safeParse(payload);
  if (!parsed.success) {
    return Response.json({ error: { code: "invalid-request" } }, { status: 400 });
  }

  await options.resetScenarioEvidence(scenarioReleaseIds);
  const scenario = await options.generate(parsed.data);
  const comparison = await options.compareReleases({
    baselineReleaseId: scenario.baselineReleaseId,
    candidateReleaseId: scenario.degradedReleaseId,
    windowMs: 60_000,
  });
  const slowTraces = await options.findSlowTraces({
    releaseId: scenario.degradedReleaseId,
    sinceMs: baselineDeployedAtMs,
    untilMs: degradedDeployedAtMs + 60_000,
    limit: 10,
  });
  const slowest = slowTraces[0];
  if (slowest === undefined) {
    return Response.json({ error: { code: "scenario-incomplete" } }, { status: 500 });
  }
  const detail = await options.getTraceDetail(slowest.traceId);
  if (detail === null) {
    return Response.json({ error: { code: "scenario-incomplete" } }, { status: 500 });
  }
  return Response.json(
    {
      scenario,
      comparison,
      slowTrace: { ...slowest, criticalPath: detail.criticalPath },
    },
    { headers: { "cache-control": "no-store" } },
  );
}
