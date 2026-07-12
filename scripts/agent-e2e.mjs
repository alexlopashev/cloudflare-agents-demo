import { createServer } from "vite";

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
  const response = await fetch(`http://127.0.0.1:${address.port}/api/scenario/investigate`, {
    method: "POST",
    headers: { "x-local-scenario-key": "regression-surgeon-local-only" },
  });
  if (!response.ok) throw new Error(`Agent E2E returned HTTP ${response.status}`);
  const result = await response.json();
  const expectedTools = [
    "tool-query_telemetry",
    "tool-query_telemetry",
    "tool-query_telemetry",
    "tool-inspect_release",
    "tool-read_repo_files",
  ];
  if (
    typeof result !== "object" ||
    result === null ||
    JSON.stringify(result.toolTypes) !== JSON.stringify(expectedTools) ||
    typeof result.report !== "string" ||
    !/Evidence[\s\S]+scenario-trace-[0-9]+[\s\S]+d591869[\s\S]+PR #19/.test(result.report) ||
    !/Inference[\s\S]+Confidence[\s\S]+Unknowns/.test(result.report)
  ) {
    throw new Error(
      `Agent E2E did not prove the evidence-driven Think loop: ${JSON.stringify(result)}`,
    );
  }
  console.log("Project Think E2E verified: five evidence tools, structured report, no live LLM.");
} finally {
  await server.close();
}
