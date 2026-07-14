import { z } from "zod";

import { parseIncidentReference } from "../packages/contracts/src/incident.ts";
import { smokeEvidenceDiagnosticSchema } from "../workers/platform/src/verification/smoke-contract.ts";

const shaSchema = z.string().regex(/^[0-9a-f]{40}$/);
const uuidSchema = z.string().uuid();

export const runtimeAttributionRetryPolicy = Object.freeze({
  maxAttempts: 80,
  delayMs: 750,
});

export const deploymentVersionPropagationPolicy = Object.freeze({
  maxAttempts: 80,
  delayMs: 750,
  consecutiveMatches: 3,
});

export const deploymentSmokeRetryPolicy = Object.freeze({
  maxAttempts: 16,
  delayMs: 750,
});

export function deploymentSmokeFailureMessage(status: number, body: unknown): string {
  const parsed = smokeEvidenceDiagnosticSchema.safeParse(body);
  if (!parsed.success) return `Public agent smoke returned HTTP ${status}.`;
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
    version_metadata: { binding: "CF_VERSION_METADATA" },
    vars: {
      ...evidence,
      GIT_SHA: gitSha,
      GITHUB_OWNER: "alexlopashev",
      GITHUB_REPO: "cloudflare-agents-demo",
      GITHUB_WRITE_ENABLED:
        options.stage.kind === "investigator" && options.stage.githubWriteEnabled
          ? "true"
          : "false",
      HEALTH_LOADING_MODE: loadingMode,
      MODEL_MODE: "workers-ai",
      SCENARIO_CONTROL_ENABLED: "false",
    },
    observability: { enabled: true },
  } as const;
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
): Promise<T> {
  try {
    const enabled = await enable();
    await verify(enabled);
    return enabled;
  } catch (enableError) {
    try {
      await rollback();
    } catch (rollbackError) {
      throw new AggregateError(
        [enableError, rollbackError],
        "GitHub write enablement failed and the write-disabled rollback could not be verified.",
      );
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
    `DELETE FROM releases WHERE release_id IN (${ids})`,
  ].join("; ");
}
