import { createServer } from "vite";
import { z } from "zod";

import { createSmokeVerificationReceipt } from "../workers/platform/src/verification/smoke-contract.ts";

const httpSessionSchema = z.object({
  session: z.object({
    id: z.string().startsWith("http-"),
    createdAtMs: z.number().int().nonnegative(),
    updatedAtMs: z.number().int().nonnegative(),
    messageCount: z.number().int().nonnegative(),
    messages: z.array(z.unknown()),
  }),
});

const httpSessionListSchema = z.object({
  sessions: z.array(
    z.object({
      id: z.string().startsWith("http-"),
      createdAtMs: z.number().int().nonnegative(),
      updatedAtMs: z.number().int().nonnegative(),
      messageCount: z.number().int().nonnegative(),
    }),
  ),
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

  const sessionResponse = await fetch(`http://127.0.0.1:${address.port}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ message: "Investigate the seeded latency regression." }),
  });
  if (sessionResponse.status !== 201) {
    throw new Error(`HTTP session creation returned HTTP ${sessionResponse.status}`);
  }
  const created = httpSessionSchema.parse(await sessionResponse.json()).session;

  const listResponse = await fetch(`http://127.0.0.1:${address.port}/api/sessions?limit=10`);
  if (!listResponse.ok) throw new Error(`HTTP session list returned HTTP ${listResponse.status}`);
  const listed = httpSessionListSchema.parse(await listResponse.json());
  if (!listed.sessions.some((session) => session.id === created.id)) {
    throw new Error("HTTP session list omitted the created session.");
  }

  const detailResponse = await fetch(`http://127.0.0.1:${address.port}/api/sessions/${created.id}`);
  if (!detailResponse.ok) {
    throw new Error(`HTTP session detail returned HTTP ${detailResponse.status}`);
  }
  const detail = httpSessionSchema.parse(await detailResponse.json()).session;
  if (detail.messages.length !== created.messageCount) {
    throw new Error("HTTP session detail did not return the complete persisted transcript.");
  }

  const followUpResponse = await fetch(
    `http://127.0.0.1:${address.port}/api/sessions/${created.id}/messages`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ message: "Summarize the remaining unknowns." }),
    },
  );
  if (!followUpResponse.ok) {
    throw new Error(`HTTP session follow-up returned HTTP ${followUpResponse.status}`);
  }
  const followedUp = httpSessionSchema.parse(await followUpResponse.json()).session;
  if (followedUp.messageCount <= created.messageCount) {
    throw new Error("HTTP session follow-up did not append to the persisted transcript.");
  }
  console.log(`HTTP session E2E verified: create, list, detail, and follow-up for ${created.id}.`);
} finally {
  await server.close();
}
