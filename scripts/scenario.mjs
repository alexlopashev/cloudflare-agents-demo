import { createServer } from "vite";

import { regressionSource } from "../packages/test-fixtures/src/scenario.ts";

const action = process.argv[2];
if (action !== "reset" && action !== "reseed") {
  throw new Error("Usage: node scripts/scenario.mjs <reset|reseed>");
}

const server = await createServer({
  configFile: new URL("../vite.config.ts", import.meta.url).pathname,
  server: { host: "127.0.0.1", port: 0 },
});

try {
  await server.listen();
  const address = server.httpServer?.address();
  if (address === null || typeof address === "string" || address === undefined) {
    throw new Error("Vite did not expose a local TCP address");
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const headers = { "x-local-scenario-key": "regression-surgeon-local-only" };
  if (action === "reset") {
    const response = await fetch(`${baseUrl}/api/scenario/reset`, { method: "POST", headers });
    if (response.status !== 204) throw new Error(`Scenario reset returned HTTP ${response.status}`);
    console.log("Controlled regression evidence reset.");
  } else {
    const response = await fetch(`${baseUrl}/api/scenario/reseed`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        goodGitSha: "cf25e5253b106b1e7514340abe94bd42fd748725",
        badGitSha: regressionSource.commitSha,
      }),
    });
    if (!response.ok) throw new Error(`Scenario reseed returned HTTP ${response.status}`);
    const result = await response.json();
    if (
      typeof result !== "object" ||
      result === null ||
      result.comparison?.status !== "ready" ||
      result.scenario?.sampleCount !== 20 ||
      result.slowTrace?.releaseId !== "regression-sequential" ||
      result.comparison.candidate?.p75Ms < result.comparison.baseline?.p75Ms * 2 ||
      result.slowTrace?.criticalPath?.durationMs < 300
    ) {
      throw new Error(
        `Scenario evidence did not prove the controlled regression: ${JSON.stringify(result)}`,
      );
    }
    console.log(
      `Controlled regression reseeded: p75 ${result.comparison.baseline.p75Ms}ms -> ${result.comparison.candidate.p75Ms}ms; slow trace ${result.slowTrace.traceId}.`,
    );
  }
} finally {
  await server.close();
}
