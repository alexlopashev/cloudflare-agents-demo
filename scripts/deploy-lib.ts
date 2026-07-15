import { createHash } from "node:crypto";

import { z } from "zod";

import { AI_GATEWAY_ID, parseAiGatewayId } from "../packages/contracts/src/ai-gateway.ts";
import { parseIncidentReference } from "../packages/contracts/src/incident.ts";
import {
  configuredSourceEvidencePolicy,
  parseReleasePreviewEvidence,
  parseReleaseSourceEvidence,
  type ReleasePreviewEvidence,
  type ReleaseSourceEvidence,
} from "../packages/contracts/src/source-evidence.ts";
import {
  smokeEvidenceDiagnosticSchema,
  smokePostEvidenceDiagnosticSchema,
} from "../workers/platform/src/verification/smoke-contract.ts";
import type { PublicUsageMode } from "../workers/platform/src/public-usage.ts";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const uuidSchema = z.string().uuid();
const platformWorkerName = "regression-surgeon-platform";

export { AI_GATEWAY_ID } from "../packages/contracts/src/ai-gateway.ts";

export const runtimeAttributionRetryPolicy = Object.freeze({
  maxAttempts: 80,
  delayMs: 750,
});

export const deploymentVersionPropagationPolicy = Object.freeze({
  maxAttempts: 80,
  delayMs: 750,
  consecutiveMatches: 3,
});

export const deploymentVersionOverrideSettlePolicy = Object.freeze({
  delayMs: 10_000,
});

export const deploymentSmokeRetryPolicy = Object.freeze({
  maxAttempts: 80,
  delayMs: 750,
});

export const deploymentEvidenceReadinessPolicy = Object.freeze({
  maxAttempts: 80,
  delayMs: 750,
});

export function deploymentSmokeFailureMessage(status: number, body: unknown): string {
  const parsed = smokeEvidenceDiagnosticSchema.safeParse(body);
  if (!parsed.success) {
    const postEvidence = smokePostEvidenceDiagnosticSchema.safeParse(body);
    if (!postEvidence.success) return `Public agent smoke returned HTTP ${status}.`;
    return postEvidence.data.error.code === "remediation-preview-failed"
      ? `Public agent smoke returned HTTP ${status}: remediation-preview-failed (${postEvidence.data.error.reason}).`
      : `Public agent smoke returned HTTP ${status}: invalid-smoke-verification (invalid fields: ${postEvidence.data.error.invalidFields.join(", ")}).`;
  }
  if (
    parsed.data.error.code === "invalid-evidence-receipt" &&
    parsed.data.error.invalidFields !== undefined &&
    parsed.data.error.invalidFields.length > 0
  ) {
    return `Public agent smoke returned HTTP ${status}: invalid-evidence-receipt (invalid fields: ${parsed.data.error.invalidFields.join(", ")}).`;
  }
  const incompletePhases = parsed.data.error.phases.filter((phase) => phase.status !== "complete");
  const detail =
    incompletePhases.length > 0
      ? incompletePhases
          .map(
            (phase) =>
              `${phase.toolName}=${phase.status}${phase.reason === undefined ? "" : `:${phase.reason}`}`,
          )
          .join(", ")
      : "prepared_remediation=missing";
  return `Public agent smoke returned HTTP ${status}: ${parsed.data.error.code} (${detail}).`;
}

export function buildDeploymentInteractionId(
  label: "baseline" | "degraded",
  releaseId: string,
  sampleNumber: number,
): string {
  const release = uuidSchema.safeParse(releaseId);
  if (!release.success) throw new TypeError("Deployment release identifier is invalid.");
  if (!Number.isInteger(sampleNumber) || sampleNumber < 1 || sampleNumber > 20) {
    throw new RangeError("Deployment sample number must be between 1 and 20.");
  }
  return `${label}-${release.data}-${String(sampleNumber).padStart(2, "0")}`;
}

export function buildExactVersionHeaders(versionId: string): Record<string, string> {
  const version = uuidSchema.safeParse(versionId);
  if (!version.success) throw new TypeError("Deployment version identifier is invalid.");
  return {
    "Cloudflare-Workers-Version-Overrides": `${platformWorkerName}="${version.data}"`,
  };
}

export function buildMeasuredVersionDeploymentSpecs(
  stableVersionId: string,
  measuredVersionId: string,
): [string, string] {
  const stable = uuidSchema.safeParse(stableVersionId);
  const measured = uuidSchema.safeParse(measuredVersionId);
  if (!stable.success || !measured.success || stable.data === measured.data) {
    throw new TypeError("Worker version identifier is invalid for measured deployment.");
  }
  return [`${stable.data}@100%`, `${measured.data}@0%`];
}

export async function requestDeploymentEndpointOnce(
  request: () => Promise<Response>,
  label: string,
): Promise<Response> {
  let response: Response;
  try {
    response = await request();
  } catch (cause) {
    throw new Error(`${label} failed before a response.`, { cause });
  }
  if (!response.ok) throw new Error(`${label} returned HTTP ${response.status}.`);
  return response;
}

export async function waitForDeploymentVersion(
  readVersion: () => Promise<string | undefined>,
  expectedVersion: string,
  wait: () => Promise<void>,
): Promise<void> {
  const expected = uuidSchema.safeParse(expectedVersion);
  if (!expected.success) throw new TypeError("Expected deployment version is invalid.");
  let consecutiveMatches = 0;
  for (let attempt = 0; attempt < deploymentVersionPropagationPolicy.maxAttempts; attempt += 1) {
    try {
      if ((await readVersion()) === expected.data) {
        consecutiveMatches += 1;
        if (consecutiveMatches >= deploymentVersionPropagationPolicy.consecutiveMatches) return;
      } else {
        consecutiveMatches = 0;
      }
    } catch {
      consecutiveMatches = 0;
      // The read-only version route can be unavailable while the edge changes versions.
    }
    if (attempt < deploymentVersionPropagationPolicy.maxAttempts - 1) await wait();
  }
  throw new Error(`Deployment version ${expected.data} did not reach the public edge.`);
}

export async function requestDeploymentSmokeWithRetry(
  request: () => Promise<Response>,
  wait: () => Promise<void>,
): Promise<Response> {
  for (let attempt = 0; attempt < deploymentSmokeRetryPolicy.maxAttempts; attempt += 1) {
    const response = await request();
    if (response.status !== 404 || attempt === deploymentSmokeRetryPolicy.maxAttempts - 1) {
      return response;
    }
    await wait();
  }
  throw new Error("Deployment smoke retry policy did not produce a response.");
}

export async function waitForDeploymentEvidenceReady(
  request: () => Promise<Response>,
  wait: () => Promise<void>,
): Promise<void> {
  for (let attempt = 0; attempt < deploymentEvidenceReadinessPolicy.maxAttempts; attempt += 1) {
    let response: Response;
    try {
      response = await request();
    } catch {
      if (attempt === deploymentEvidenceReadinessPolicy.maxAttempts - 1) break;
      await wait();
      continue;
    }
    if (response.status === 204) return;
    if (response.status !== 404 && response.status !== 503) {
      throw new Error(`Deployment evidence readiness returned HTTP ${response.status}.`);
    }
    if (attempt < deploymentEvidenceReadinessPolicy.maxAttempts - 1) await wait();
  }
  throw new Error("Deployment evidence did not become readable at the public edge.");
}

export type DeploymentStage =
  | { kind: "baseline"; gitSha: string }
  | { kind: "regression"; gitSha: string }
  | {
      kind: "investigator";
      incidentId: string;
      gitSha: string;
      baselineReleaseId: string;
      degradedReleaseId: string;
      degradedSinceMs: number;
      degradedUntilMs: number;
      smokeKey: string;
      githubWriteEnabled: boolean;
      publicUsageMode?: Extract<PublicUsageMode, "disabled" | "rate-limited">;
    };

type DeploymentConfigOptions = {
  databaseId: string;
  repositoryRoot: string;
  stage: DeploymentStage;
};

export function buildPlatformDeploymentConfig(options: DeploymentConfigOptions) {
  const databaseId = uuidSchema.parse(options.databaseId);
  const gitSha = shaSchema.parse(options.stage.gitSha);
  const evidence =
    options.stage.kind === "investigator"
      ? (() => {
          const incident = parseIncidentReference({
            incidentId: options.stage.incidentId,
            baselineReleaseId: parseVersionId(options.stage.baselineReleaseId),
            degradedReleaseId: parseVersionId(options.stage.degradedReleaseId),
            traceWindow: {
              sinceMs: options.stage.degradedSinceMs,
              untilMs: options.stage.degradedUntilMs,
            },
          });
          return {
            EVIDENCE_INCIDENT_ID: incident.incidentId,
            EVIDENCE_BASELINE_RELEASE_ID: incident.baselineReleaseId,
            EVIDENCE_DEGRADED_RELEASE_ID: incident.degradedReleaseId,
            EVIDENCE_DEGRADED_SINCE_MS: incident.traceWindow.sinceMs.toString(),
            EVIDENCE_DEGRADED_UNTIL_MS: incident.traceWindow.untilMs.toString(),
          };
        })()
      : {
          EVIDENCE_INCIDENT_ID: "",
          EVIDENCE_BASELINE_RELEASE_ID: "",
          EVIDENCE_DEGRADED_RELEASE_ID: "",
          EVIDENCE_DEGRADED_SINCE_MS: "",
          EVIDENCE_DEGRADED_UNTIL_MS: "",
        };
  const loadingMode = options.stage.kind === "baseline" ? "concurrent" : "sequential";
  const publicUsageMode =
    options.stage.kind === "investigator"
      ? (options.stage.publicUsageMode ?? "rate-limited")
      : "rate-limited";
  if (options.stage.kind === "investigator") {
    z.string().min(20).max(128).parse(options.stage.smokeKey);
  }
  const root = options.repositoryRoot.replace(/\/$/, "");

  return {
    name: "regression-surgeon-platform",
    main: `${root}/workers/platform/src/index.ts`,
    compatibility_date: "2026-07-11",
    compatibility_flags: ["nodejs_compat"],
    assets: {
      binding: "ASSETS",
      directory: `${root}/apps/web/dist/client`,
      not_found_handling: "single-page-application",
      run_worker_first: ["/api/*", "/agents/*"],
    },
    ai: { binding: "AI" },
    durable_objects: {
      bindings: [{ class_name: "RegressionSurgeonAgent", name: "REGRESSION_SURGEON_AGENT" }],
    },
    migrations: [{ new_sqlite_classes: ["RegressionSurgeonAgent"], tag: "v1" }],
    d1_databases: [
      {
        binding: "TELEMETRY_DB",
        database_id: databaseId,
        database_name: "regression-surgeon-telemetry",
        migrations_dir: `${root}/migrations/telemetry`,
      },
    ],
    services: [{ binding: "HEALTH_SERVICE", service: "regression-surgeon-health-service" }],
    ratelimits: [
      {
        name: "PUBLIC_AI_TURN_LIMITER",
        namespace_id: "4747001",
        simple: { limit: 10, period: 60 },
      },
      {
        name: "PUBLIC_METRIC_LIMITER",
        namespace_id: "4747002",
        simple: { limit: 60, period: 60 },
      },
    ],
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      ...evidence,
      AI_GATEWAY_ID,
      GIT_SHA: gitSha,
      GITHUB_OWNER: "alexlopashev",
      GITHUB_REPO: "cloudflare-agents-demo",
      GITHUB_WRITE_ENABLED:
        options.stage.kind === "investigator" && options.stage.githubWriteEnabled
          ? "true"
          : "false",
      HEALTH_LOADING_MODE: loadingMode,
      MODEL_MODE: "workers-ai",
      PUBLIC_USAGE_MODE: publicUsageMode,
      SCENARIO_CONTROL_ENABLED: "false",
    },
    observability: { enabled: true },
  } as const;
}

const accountIdSchema = z.string().regex(/^[a-f0-9]{32}$/);
const aiGatewayEnvelopeSchema = z.object({
  success: z.literal(true),
  result: z.object({
    id: z.literal(AI_GATEWAY_ID),
    collect_logs: z.literal(true),
  }),
});

export function parseCloudflareAccountId(output: string): string {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("Cloudflare account evidence is invalid.");
  }
  const parsed = z
    .object({ accounts: z.array(z.object({ id: accountIdSchema }).passthrough()).length(1) })
    .safeParse(value);
  if (!parsed.success) throw new Error("One exact Cloudflare account is required.");
  const account = parsed.data.accounts[0];
  if (account === undefined) throw new Error("One exact Cloudflare account is required.");
  return account.id;
}

export function parseCloudflareAiGatewayApiToken(value: string | undefined): string {
  const parsed = z.string().trim().min(20).max(4096).safeParse(value);
  if (!parsed.success) {
    throw new Error(
      "AI Gateway management requires CLOUDFLARE_API_TOKEN with AI Gateway Write permission.",
    );
  }
  return parsed.data;
}

type CloudflareApiRequest = (input: string, init?: RequestInit) => Promise<Response>;

export async function ensureCloudflareAiGateway(
  request: CloudflareApiRequest,
  accountId: string,
): Promise<{ id: string }> {
  const account = accountIdSchema.parse(accountId);
  const gatewayId = parseAiGatewayId(AI_GATEWAY_ID);
  const collection = `https://api.cloudflare.com/client/v4/accounts/${account}/ai-gateway/gateways`;
  let response = await request(`${collection}/${gatewayId}`);
  if (response.status === 404) {
    response = await request(collection, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: gatewayId,
        cache_invalidate_on_update: true,
        cache_ttl: 0,
        collect_logs: true,
        rate_limiting_interval: 0,
        rate_limiting_limit: 0,
      }),
    });
  }
  if (!response.ok) throw new Error(`AI Gateway verification returned HTTP ${response.status}.`);
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("AI Gateway verification returned invalid evidence.");
  }
  const parsed = aiGatewayEnvelopeSchema.safeParse(value);
  if (!parsed.success) throw new Error("AI Gateway verification did not match the named gateway.");
  return { id: parsed.data.result.id };
}

function parseVersionId(value: string): string {
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) throw new Error("Cloudflare version identifier is invalid.");
  return parsed.data;
}

export function parseD1DatabaseId(output: string): string {
  const parsed = z.array(z.object({ name: z.string(), uuid: uuidSchema })).safeParse(
    (() => {
      try {
        return JSON.parse(output) as unknown;
      } catch {
        return null;
      }
    })(),
  );
  const listed = parsed.success
    ? parsed.data.find((database) => database.name === "regression-surgeon-telemetry")?.uuid
    : undefined;
  const created = /["']?database_id["']?\s*(?::|=)\s*"([0-9a-f-]+)"/i.exec(output)?.[1];
  const result = listed ?? created;
  if (result === undefined || !uuidSchema.safeParse(result).success) {
    throw new Error("Cloudflare D1 database identifier is unavailable.");
  }
  return result;
}

export function parseDeploymentResult(output: string): { url: string; versionId: string } {
  const url = /https:\/\/[A-Za-z0-9.-]+\.workers\.dev\/?/.exec(output)?.[0]?.replace(/\/$/, "");
  const versionId = /Version ID:\s*([0-9a-f-]+)/i.exec(output)?.[1];
  if (url === undefined || versionId === undefined || !uuidSchema.safeParse(versionId).success) {
    throw new Error("Cloudflare deployment evidence is unavailable.");
  }
  return { url, versionId };
}

export function parseUploadedVersionId(output: string): string {
  const versionId = /(?:Worker )?Version ID:\s*([0-9a-f-]+)/i.exec(output)?.[1];
  if (versionId === undefined || !uuidSchema.safeParse(versionId).success) {
    throw new Error("Cloudflare uploaded Worker version evidence is unavailable.");
  }
  return versionId;
}

export function parseCurrentDeploymentVersion(output: string): string {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("The current write-disabled investigator deployment is invalid.");
  }
  const parsed = z
    .object({
      versions: z
        .array(
          z.object({
            version_id: z.string().uuid(),
            percentage: z.number().finite().min(0).max(100),
          }),
        )
        .max(2),
    })
    .safeParse(value);
  if (
    !parsed.success ||
    parsed.data.versions.length !== 1 ||
    parsed.data.versions[0]?.percentage !== 100
  ) {
    throw new Error("The current write-disabled investigator deployment is unavailable.");
  }
  return parsed.data.versions[0].version_id;
}

export function parseWriteDisabledInvestigatorVersion(
  deploymentOutput: string,
  versionOutput: string,
): string {
  const activeVersionId = parseCurrentDeploymentVersion(deploymentOutput);
  let value: unknown;
  try {
    value = JSON.parse(versionOutput) as unknown;
  } catch {
    throw new Error("The current write-disabled investigator version is invalid.");
  }
  const parsed = z
    .object({
      id: z.string().uuid(),
      resources: z.object({
        bindings: z
          .array(
            z
              .object({
                name: z.string().min(1).max(128),
                type: z.string().min(1).max(64),
                text: z.string().max(512).optional(),
              })
              .passthrough(),
          )
          .max(64),
      }),
    })
    .safeParse(value);
  if (!parsed.success || parsed.data.id !== activeVersionId) {
    throw new Error("The current write-disabled investigator version is unavailable.");
  }
  const bindings = parsed.data.resources.bindings;
  const textBinding = (name: string, expected: string) =>
    bindings.some(
      (binding) =>
        binding.type === "plain_text" && binding.name === name && binding.text === expected,
    );
  const hasIncident = bindings.some(
    (binding) =>
      binding.type === "plain_text" &&
      binding.name === "EVIDENCE_INCIDENT_ID" &&
      binding.text !== undefined &&
      binding.text.length > 0,
  );
  if (
    !textBinding("MODEL_MODE", "workers-ai") ||
    !textBinding("GITHUB_WRITE_ENABLED", "false") ||
    !hasIncident
  ) {
    throw new Error("The current Worker is not a write-disabled investigator version.");
  }
  return activeVersionId;
}

export function parseGitHubWriteSecretInventory(output: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(output) as unknown;
  } catch {
    throw new Error("Cloudflare secret inventory is invalid.");
  }
  const parsed = z
    .array(
      z
        .object({
          name: z.string().min(1).max(128),
          type: z.literal("secret_text"),
        })
        .passthrough(),
    )
    .max(32)
    .safeParse(value);
  if (!parsed.success) throw new Error("Cloudflare secret inventory is invalid.");
  return parsed.data.some((secret) => secret.name === "GITHUB_TOKEN");
}

export async function runWithFailClosedRollback<T>(
  enable: () => Promise<T>,
  verify: (enabled: T) => Promise<void>,
  rollback: () => Promise<void>,
  aggregateFailureMessage = "GitHub write enablement failed and the write-disabled rollback could not be verified.",
): Promise<T> {
  try {
    const enabled = await enable();
    await verify(enabled);
    return enabled;
  } catch (enableError) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError([enableError, rollbackError], aggregateFailureMessage);
    }
    throw enableError;
  }
}

export function buildEvidenceResetSql(
  baselineReleaseId: string,
  degradedReleaseId: string,
): string {
  const baseline = parseVersionId(baselineReleaseId);
  const degraded = parseVersionId(degradedReleaseId);
  const ids = `'${baseline}','${degraded}'`;
  return [
    `DELETE FROM ux_events WHERE release_id IN (${ids})`,
    `DELETE FROM spans WHERE trace_id IN (SELECT trace_id FROM traces WHERE release_id IN (${ids}))`,
    `DELETE FROM traces WHERE release_id IN (${ids})`,
    `DELETE FROM release_preview_evidence WHERE release_id IN (${ids})`,
    `DELETE FROM release_source_evidence WHERE release_id IN (${ids})`,
    `DELETE FROM releases WHERE release_id IN (${ids})`,
  ].join("; ");
}

type ImmutableGitSource = {
  sha: string;
  content: string;
  blobSha: string;
};

type RegressionGitSource = ImmutableGitSource & {
  subject: string;
  committedAt: string;
};

export type ConfiguredSourceEvidenceInput = {
  releaseId: string;
  regression: RegressionGitSource;
  head: ImmutableGitSource;
  base: ImmutableGitSource;
};

function gitBlobSha(content: string): string {
  const bytes = Buffer.from(content, "utf8");
  return createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
}

function sourceProofError(): TypeError {
  return new TypeError("Configured local Git source proof is invalid.");
}

export function buildConfiguredSourceEvidence(
  input: ConfiguredSourceEvidenceInput,
): ReleaseSourceEvidence {
  const policy = configuredSourceEvidencePolicy;
  if (
    input.regression.sha !== policy.regressionCommitSha ||
    input.head.sha !== policy.pullRequestHeadSha ||
    input.base.sha !== policy.pullRequestBaseSha ||
    input.regression.blobSha !== gitBlobSha(input.regression.content) ||
    input.head.blobSha !== gitBlobSha(input.head.content) ||
    input.base.blobSha !== gitBlobSha(input.base.content) ||
    input.regression.content !== input.head.content ||
    input.regression.blobSha !== input.head.blobSha ||
    input.regression.content === input.base.content ||
    input.regression.blobSha === input.base.blobSha
  ) {
    throw sourceProofError();
  }
  try {
    return parseReleaseSourceEvidence({
      releaseId: input.releaseId,
      commitSha: input.regression.sha,
      commitSubject: input.regression.subject,
      committedAt: input.regression.committedAt,
      pullRequestNumber: policy.pullRequestNumber,
      pullRequestHeadSha: input.head.sha,
      sourcePath: policy.sourcePath,
      blobSha: input.regression.blobSha,
      byteLength: Buffer.byteLength(input.regression.content, "utf8"),
      content: input.regression.content,
    });
  } catch {
    throw sourceProofError();
  }
}

function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function buildReleaseSourceEvidenceSql(input: ReleaseSourceEvidence): string {
  const evidence = parseReleaseSourceEvidence(input);
  const values = [
    sqlString(evidence.releaseId),
    sqlString(evidence.commitSha),
    sqlString(evidence.commitSubject),
    sqlString(evidence.committedAt),
    String(evidence.pullRequestNumber),
    sqlString(evidence.pullRequestHeadSha),
    sqlString(evidence.sourcePath),
    sqlString(evidence.blobSha),
    String(evidence.byteLength),
    sqlString(evidence.content),
  ].join(", ");
  return `INSERT INTO release_source_evidence
    (release_id, commit_sha, commit_subject, committed_at, pull_request_number,
     pull_request_head_sha, source_path, blob_sha, byte_length, content)
    VALUES (${values})
    ON CONFLICT (release_id) DO UPDATE SET
      commit_sha = excluded.commit_sha,
      commit_subject = excluded.commit_subject,
      committed_at = excluded.committed_at,
      pull_request_number = excluded.pull_request_number,
      pull_request_head_sha = excluded.pull_request_head_sha,
      source_path = excluded.source_path,
      blob_sha = excluded.blob_sha,
      byte_length = excluded.byte_length,
      content = excluded.content;`;
}

export function buildConfiguredPreviewEvidence(input: {
  releaseId: string;
  source: ImmutableGitSource;
  evidenced: { content: string; blobSha: string };
}): ReleasePreviewEvidence {
  if (
    !shaSchema.safeParse(input.source.sha).success ||
    input.source.blobSha !== gitBlobSha(input.source.content) ||
    input.source.content !== input.evidenced.content ||
    input.source.blobSha !== input.evidenced.blobSha
  ) {
    throw new TypeError("Configured local Git preview proof is invalid.");
  }
  try {
    return parseReleasePreviewEvidence({
      releaseId: input.releaseId,
      baseSha: input.source.sha,
      sourcePath: configuredSourceEvidencePolicy.sourcePath,
      blobSha: input.source.blobSha,
      byteLength: Buffer.byteLength(input.source.content, "utf8"),
      content: input.source.content,
    });
  } catch {
    throw new TypeError("Configured local Git preview proof is invalid.");
  }
}

export function buildReleasePreviewEvidenceSql(input: ReleasePreviewEvidence): string {
  const evidence = parseReleasePreviewEvidence(input);
  const values = [
    sqlString(evidence.releaseId),
    sqlString(evidence.baseSha),
    sqlString(evidence.sourcePath),
    sqlString(evidence.blobSha),
    String(evidence.byteLength),
    sqlString(evidence.content),
  ].join(", ");
  return `INSERT INTO release_preview_evidence
    (release_id, base_sha, source_path, blob_sha, byte_length, content)
    VALUES (${values})
    ON CONFLICT (release_id, base_sha) DO UPDATE SET
      source_path = excluded.source_path,
      blob_sha = excluded.blob_sha,
      byte_length = excluded.byte_length,
      content = excluded.content;
    DELETE FROM release_preview_evidence
      WHERE release_id = ${sqlString(evidence.releaseId)}
        AND base_sha <> ${sqlString(evidence.baseSha)};`;
}
