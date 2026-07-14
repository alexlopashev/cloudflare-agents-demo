import { createServer } from "vite";

import { createSmokeVerificationReceipt } from "../workers/platform/src/verification/smoke-contract.ts";

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
  const investigation = await response.json();
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
  const remediation = await previewResponse.json();
  const verification = createSmokeVerificationReceipt({ investigation, remediation });
  if (verification.incident.incidentId !== "configured-latency-regression") {
    throw new Error("Agent E2E did not preserve the configured incident identity.");
  }
  console.log(
    `Project Think E2E verified: ${verification.phases.length} exact evidence phases and structured report.`,
  );
  console.log(
    `Guarded remediation E2E verified: fingerprint ${verification.remediation.fingerprint}, validated preview, zero GitHub writes.`,
  );
} finally {
  await server.close();
}
