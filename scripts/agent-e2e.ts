import { createServer } from "vite";
import { z } from "zod";

import { incidentReferenceSchema } from "../packages/contracts/src/incident.ts";

const investigationResultSchema = z.object({
  incident: incidentReferenceSchema,
  report: z.string(),
  toolTypes: z.array(z.string()),
});

const remediationPreviewSchema = z.object({
  body: z.string(),
  branch: z.string(),
  status: z.literal("preview"),
  writesPerformed: z.literal(false),
});

const server: Awaited<ReturnType<typeof createServer>> = await createServer({
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
  const result = investigationResultSchema.safeParse(await response.json());
  const expectedTools = [
    "tool-query_telemetry",
    "tool-query_telemetry",
    "tool-query_telemetry",
    "tool-inspect_release",
    "tool-read_repo_files",
  ];
  if (
    !result.success ||
    result.data.incident.incidentId !== "configured-latency-regression" ||
    JSON.stringify(result.data.toolTypes) !== JSON.stringify(expectedTools) ||
    !result.data.report.includes(result.data.incident.incidentId) ||
    !/Evidence[\s\S]+scenario-trace-[0-9]+[\s\S]+d591869[\s\S]+PR #19/.test(result.data.report) ||
    !/Inference[\s\S]+Confidence[\s\S]+Unknowns/.test(result.data.report)
  ) {
    throw new Error(
      `Agent E2E did not prove the evidence-driven Think loop: ${JSON.stringify(result)}`,
    );
  }
  const investigatedTraceId = /Representative trace: (scenario-trace-[0-9]+)/.exec(
    result.data.report,
  )?.[1];
  if (investigatedTraceId === undefined) {
    throw new Error("Agent E2E report did not expose its representative trace");
  }
  const previewResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/scenario/remediation-preview`,
    {
      method: "POST",
      headers: { "x-local-scenario-key": "regression-surgeon-local-only" },
    },
  );
  if (!previewResponse.ok) {
    throw new Error(`Remediation preview E2E returned HTTP ${previewResponse.status}`);
  }
  const preview = remediationPreviewSchema.safeParse(await previewResponse.json());
  if (
    !preview.success ||
    !/^regression-surgeon\/[0-9a-f]{16}$/.test(preview.data.branch) ||
    !preview.data.body.includes(investigatedTraceId) ||
    !preview.data.body.includes(result.data.incident.incidentId) ||
    !/Evidence[\s\S]+d591869[\s\S]+PR #19/.test(preview.data.body) ||
    !/Risk[\s\S]+Validation/.test(preview.data.body)
  ) {
    throw new Error(
      `Remediation E2E did not prove preview-only safety: ${JSON.stringify(preview)}`,
    );
  }
  console.log("Project Think E2E verified: five evidence tools, structured report, no live LLM.");
  console.log("Guarded remediation E2E verified: validated preview, zero GitHub writes.");
} finally {
  await server.close();
}
