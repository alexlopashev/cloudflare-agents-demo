export type StackVerification = {
  health: "ok";
  mode: "fake";
  routes: ["/app", "/investigator"];
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
    await fetcher(new URL("/api/health", baseUrl)),
    "health-service",
  );
  if (health.service !== "health-service" || health.status !== "ok") {
    throw new Error("health-service did not prove the auxiliary Worker binding");
  }

  const runtime = await requireJson(
    await fetcher(new URL("/api/runtime", baseUrl)),
    "runtime metadata",
  );
  if (runtime.mode !== "fake")
    throw new Error("local runtime must default to credential-free fake mode");

  return { health: "ok", mode: "fake", routes: [...routes] };
}
