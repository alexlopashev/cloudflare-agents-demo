import { healthReportSchema } from "../packages/contracts/src/health.ts";

export type StackVerification = {
  health: "healthy";
  mode: "fake";
  routes: ["/app", "/investigator"];
  telemetry: "accepted";
};

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

async function requireJson(response: Response, label: string): Promise<Record<string, unknown>> {
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}`);
  const value: unknown = await response.json();
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} returned a non-object payload`);
  }
  return value as Record<string, unknown>;
}

export async function verifyLocalStack(
  baseUrl: string,
  fetcher: Fetcher = fetch,
  createInteractionId: () => string = () => crypto.randomUUID(),
): Promise<StackVerification> {
  const routes = ["/app", "/investigator"] as const;
  for (const route of routes) {
    const response = await fetcher(new URL(route, baseUrl));
    const contentType = response.headers.get("content-type") ?? "";
    if (
      !response.ok ||
      !contentType.includes("text/html") ||
      !(await response.text()).includes('id="root"')
    ) {
      throw new Error(`${route} did not return the application shell`);
    }
  }

  const health = await requireJson(
    await fetcher(
      new Request(new URL("/api/health", baseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ interactionId: createInteractionId() }),
      }),
    ),
    "health report",
  );
  const parsedHealth = healthReportSchema.safeParse(health);
  if (!parsedHealth.success || parsedHealth.data.outcome !== "healthy") {
    throw new Error("health report did not prove the auxiliary Worker aggregation");
  }

  const telemetryResponse = await fetcher(
    new Request(new URL("/api/telemetry/ux", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        interactionId: parsedHealth.data.interactionId,
        traceId: parsedHealth.data.traceId,
        releaseId: parsedHealth.data.releaseId,
        metricName: "service_grid_ready_ms",
        durationMs: 1,
        outcome: "success",
      }),
    }),
  );
  if (telemetryResponse.status !== 204) {
    throw new Error(`UX telemetry returned HTTP ${telemetryResponse.status}`);
  }

  const runtime = await requireJson(
    await fetcher(new URL("/api/runtime", baseUrl)),
    "runtime metadata",
  );
  if (runtime.mode !== "fake")
    throw new Error("local runtime must default to credential-free fake mode");

  return { health: "healthy", mode: "fake", routes: [...routes], telemetry: "accepted" };
}
