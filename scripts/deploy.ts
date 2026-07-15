import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

import { smokeVerificationReceiptSchema } from "../workers/platform/src/verification/smoke-contract.ts";
import { configuredSourceEvidencePolicy } from "../packages/contracts/src/source-evidence.ts";

import {
  buildExactVersionHeaders,
  buildDeploymentInteractionId,
  buildMeasuredVersionDeploymentSpecs,
  buildPlatformDeploymentConfig,
  buildConfiguredPreviewEvidence,
  buildConfiguredSourceEvidence,
  buildEvidenceResetSql,
  buildReleasePreviewEvidenceSql,
  buildReleaseSourceEvidenceSql,
  AI_GATEWAY_ID,
  deploymentSmokeRetryPolicy,
  deploymentSmokeFailureMessage,
  deploymentEvidenceReadinessPolicy,
  deploymentVersionOverrideSettlePolicy,
  deploymentVersionPropagationPolicy,
  parseD1DatabaseId,
  parseCloudflareAccountId,
  parseCloudflareAiGatewayApiToken,
  parseDeploymentResult,
  parseCurrentDeploymentVersion,
  parseGitHubWriteSecretInventory,
  parseUploadedVersionId,
  parseWriteDisabledInvestigatorVersion,
  requestDeploymentEndpointOnce,
  requestDeploymentSmokeWithRetry,
  runtimeAttributionRetryPolicy,
  runWithFailClosedRollback,
  ensureCloudflareAiGateway,
  waitForDeploymentVersion,
  waitForDeploymentEvidenceReady,
} from "./deploy-lib.ts";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const deploymentDirectory = resolve(repositoryRoot, ".local/deploy");
const configPath = resolve(deploymentDirectory, "wrangler.json");
const statePath = resolve(deploymentDirectory, "state.json");
const baselineGitSha = "cf25e5253b106b1e7514340abe94bd42fd748725";
const regressionGitSha = "d591869a8ef995f1835ef80152f4de085b10255b";
const platformWorkerName = "regression-surgeon-platform";
const platformPublicUrl = "https://regression-surgeon-platform.alexlopashev.workers.dev";

const stateSchema = z.object({
  aiGatewayId: z.literal(AI_GATEWAY_ID).default(AI_GATEWAY_ID),
  databaseId: z.string().uuid(),
  publicUrl: z.string().url(),
  incidentId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
  baselineReleaseId: z.string().uuid(),
  degradedReleaseId: z.string().uuid(),
  degradedSinceMs: z.number().int().nonnegative(),
  degradedUntilMs: z.number().int().positive(),
  investigatorReleaseId: z.string().uuid(),
  deployedGitSha: z.string().regex(/^[0-9a-f]{40}$/),
  githubWriteEnabled: z.boolean().default(false),
  publicUsageMode: z.enum(["disabled", "rate-limited"]).default("rate-limited"),
  smokeKey: z.string().min(20).max(128),
});
const refreshStateSchema = stateSchema.omit({ smokeKey: true });

function run(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  if (output.trim()) process.stdout.write(output);
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}.`,
    );
  }
  return output;
}

function capture(command: string, args: string[]): string {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1" },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with status ${result.status ?? "unknown"}.`,
    );
  }
  return result.stdout ?? "";
}

function writeConfig(config: ReturnType<typeof buildPlatformDeploymentConfig>) {
  mkdirSync(deploymentDirectory, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function findOrCreateDatabase(): string {
  const listed = run("wrangler", ["d1", "list", "--json"]);
  try {
    return parseD1DatabaseId(listed);
  } catch {
    return parseD1DatabaseId(
      run("wrangler", ["d1", "create", "regression-surgeon-telemetry", "--location", "wnam"]),
    );
  }
}

async function ensureNamedAiGateway() {
  const accountId = parseCloudflareAccountId(capture("wrangler", ["whoami", "--json"]));
  const token = parseCloudflareAiGatewayApiToken(process.env.CLOUDFLARE_API_TOKEN);
  await ensureCloudflareAiGateway(
    (input, init) =>
      fetch(input, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          authorization: `Bearer ${token}`,
        },
      }),
    accountId,
  );
}

function readGitSource(sha: string) {
  const policy = configuredSourceEvidencePolicy;
  return {
    sha,
    content: capture("git", ["show", `${sha}:${policy.sourcePath}`]),
    blobSha: capture("git", ["rev-parse", `${sha}:${policy.sourcePath}`]).trim(),
  };
}

function readConfiguredSourceEvidence(releaseId: string) {
  const policy = configuredSourceEvidencePolicy;
  return buildConfiguredSourceEvidence({
    releaseId,
    regression: {
      ...readGitSource(policy.regressionCommitSha),
      subject: capture("git", ["show", "-s", "--format=%s", policy.regressionCommitSha]).trim(),
      committedAt: capture("git", [
        "show",
        "-s",
        "--format=%cI",
        policy.regressionCommitSha,
      ]).trim(),
    },
    head: readGitSource(policy.pullRequestHeadSha),
    base: readGitSource(policy.pullRequestBaseSha),
  });
}

function prepareRemoteSourceEvidence(
  databaseId: string,
  degradedReleaseId: string,
  deployedGitSha: string,
) {
  writeConfig(
    buildPlatformDeploymentConfig({
      databaseId,
      repositoryRoot,
      stage: { kind: "regression", gitSha: regressionGitSha },
    }),
  );
  run("wrangler", [
    "d1",
    "migrations",
    "apply",
    "regression-surgeon-telemetry",
    "--remote",
    "--config",
    configPath,
  ]);
  const sourceEvidence = readConfiguredSourceEvidence(degradedReleaseId);
  const previewEvidence = buildConfiguredPreviewEvidence({
    releaseId: degradedReleaseId,
    source: readGitSource(deployedGitSha),
    evidenced: sourceEvidence,
  });
  const sourceEvidencePath = resolve(deploymentDirectory, "source-evidence.sql");
  writeFileSync(
    sourceEvidencePath,
    `${buildReleaseSourceEvidenceSql(sourceEvidence)}\n${buildReleasePreviewEvidenceSql(previewEvidence)}\n`,
    { mode: 0o600 },
  );
  try {
    run("wrangler", [
      "d1",
      "execute",
      "regression-surgeon-telemetry",
      "--remote",
      "--config",
      configPath,
      "--file",
      sourceEvidencePath,
    ]);
  } finally {
    rmSync(sourceEvidencePath, { force: true });
  }
}

function assertGitHubWriteSecret() {
  const inventory = run("wrangler", [
    "secret",
    "list",
    "--name",
    "regression-surgeon-platform",
    "--format",
    "json",
  ]);
  if (!parseGitHubWriteSecretInventory(inventory)) {
    throw new Error(
      "GitHub writes require the remote GITHUB_TOKEN secret; run mise run github:writes:secret.",
    );
  }
}

function deployPlatform(
  config: ReturnType<typeof buildPlatformDeploymentConfig>,
  secretsFile?: string,
) {
  writeConfig(config);
  return parseDeploymentResult(
    run("wrangler", [
      "deploy",
      "--config",
      configPath,
      "--strict",
      ...(secretsFile === undefined ? [] : ["--secrets-file", secretsFile]),
    ]),
  );
}

function readWriteDisabledInvestigatorVersion() {
  const deployment = capture("wrangler", [
    "deployments",
    "status",
    "--name",
    platformWorkerName,
    "--json",
  ]);
  const versionId = parseCurrentDeploymentVersion(deployment);
  const version = capture("wrangler", [
    "versions",
    "view",
    versionId,
    "--name",
    platformWorkerName,
    "--json",
  ]);
  return parseWriteDisabledInvestigatorVersion(deployment, version);
}

function uploadPlatformVersion(config: ReturnType<typeof buildPlatformDeploymentConfig>) {
  writeConfig(config);
  return parseUploadedVersionId(
    run("wrangler", ["versions", "upload", "--config", configPath, "--strict"]),
  );
}

function deployMeasuredVersion(stableVersionId: string, measuredVersionId: string) {
  run("wrangler", [
    "versions",
    "deploy",
    ...buildMeasuredVersionDeploymentSpecs(stableVersionId, measuredVersionId),
    "--yes",
    "--config",
    configPath,
  ]);
}

function deployPlatformWithSmokeSecret(
  config: ReturnType<typeof buildPlatformDeploymentConfig>,
  smokeKey: string,
) {
  deployPlatform(config);
  const secretsPath = resolve(deploymentDirectory, "secrets.json");
  writeFileSync(secretsPath, `${JSON.stringify({ DEPLOY_SMOKE_KEY: smokeKey })}\n`, {
    mode: 0o600,
  });
  try {
    return deployPlatform(config, secretsPath);
  } finally {
    rmSync(secretsPath, { force: true });
  }
}

const healthResponseSchema = z.object({
  interactionId: z.string(),
  traceId: z.string(),
  releaseId: z.string().uuid(),
  outcome: z.enum(["healthy", "partial", "failed"]),
});
const deploymentReadinessSchema = z.object({
  versionId: z.string().uuid(),
  gitSha: z.string().regex(/^[0-9a-f]{40}$/),
});

async function assertDeployedVersion(
  url: string,
  expectedVersion: string,
  headers?: Record<string, string>,
) {
  await waitForDeploymentVersion(
    async () => {
      const response = await fetch(
        `${url}/api/deployment-readiness`,
        headers === undefined ? undefined : { headers },
      );
      if (!response.ok) return undefined;
      const readiness = deploymentReadinessSchema.safeParse(await response.json());
      return readiness.success ? readiness.data.versionId : undefined;
    },
    expectedVersion,
    async () =>
      new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, deploymentVersionPropagationPolicy.delayMs),
      ),
  );
}

async function restoreWriteDisabledInvestigator(stableVersionId: string) {
  run("wrangler", [
    "rollback",
    stableVersionId,
    "--yes",
    "--name",
    platformWorkerName,
    "--message",
    "Restore write-disabled investigator after failed normal deployment",
  ]);
  await assertDeployedVersion(platformPublicUrl, stableVersionId);
  console.error("Normal deployment failed; restored the write-disabled investigator route.");
}

async function waitForVersionOverrideSettle() {
  await new Promise<void>((resolveDelay) =>
    setTimeout(resolveDelay, deploymentVersionOverrideSettlePolicy.delayMs),
  );
}

async function assertRuntimeAttribution(state: z.infer<typeof stateSchema>) {
  const runtimeSchema = z.object({
    aiGatewayId: z.literal(state.aiGatewayId),
    mode: z.literal("workers-ai"),
    versionId: z.literal(state.investigatorReleaseId),
    gitSha: z.literal(state.deployedGitSha),
    githubWriteEnabled: z.literal(state.githubWriteEnabled),
    publicUsageMode: z.literal(state.publicUsageMode),
    incident: z.object({
      incidentId: z.literal(state.incidentId),
      baselineReleaseId: z.literal(state.baselineReleaseId),
      degradedReleaseId: z.literal(state.degradedReleaseId),
      traceWindow: z.object({
        sinceMs: z.literal(state.degradedSinceMs),
        untilMs: z.literal(state.degradedUntilMs),
      }),
    }),
  });
  for (let attempt = 0; attempt < runtimeAttributionRetryPolicy.maxAttempts; attempt += 1) {
    try {
      const response = await fetch(`${state.publicUrl}/api/runtime`);
      if (response.ok) {
        const parsed = runtimeSchema.safeParse(await response.json());
        if (parsed.success) return parsed.data;
      }
    } catch {
      // Runtime identity is a side-effect-free lookup while a new version reaches every edge.
    }
    await new Promise<void>((resolveDelay) =>
      setTimeout(resolveDelay, runtimeAttributionRetryPolicy.delayMs),
    );
  }
  throw new Error("The exact deployed runtime did not reach the edge.");
}

async function seedMeasuredTraffic(
  url: string,
  expectedReleaseId: string,
  label: "baseline" | "degraded",
) {
  const exactVersionHeaders = buildExactVersionHeaders(expectedReleaseId);
  const startedAtMs = Date.now();
  const durations: number[] = [];
  for (let sample = 0; sample < 20; sample += 1) {
    const interactionId = buildDeploymentInteractionId(label, expectedReleaseId, sample + 1);
    const startedAt = performance.now();
    const response = await requestDeploymentEndpointOnce(
      async () =>
        fetch(`${url}/api/health`, {
          method: "POST",
          headers: {
            ...exactVersionHeaders,
            "content-type": "application/vnd.regression-surgeon.deployment-health+json",
            "x-deployment-expected-release": expectedReleaseId,
          },
          body: JSON.stringify({ interactionId }),
        }),
      `${label} health sample ${interactionId}`,
    );
    const durationMs = performance.now() - startedAt;
    const health = healthResponseSchema.parse(await response.json());
    if (health.releaseId !== expectedReleaseId) {
      throw new Error(`Expected release ${expectedReleaseId}, received ${health.releaseId}.`);
    }
    const telemetry = await requestDeploymentEndpointOnce(
      async () =>
        fetch(`${url}/api/telemetry/ux`, {
          method: "POST",
          headers: { ...exactVersionHeaders, "content-type": "application/json" },
          body: JSON.stringify({
            interactionId,
            traceId: health.traceId,
            releaseId: health.releaseId,
            metricName: "service_grid_ready_ms",
            durationMs,
            outcome:
              health.outcome === "healthy"
                ? "success"
                : health.outcome === "partial"
                  ? "partial"
                  : "error",
          }),
        }),
      `${label} telemetry sample ${interactionId}`,
    );
    if (telemetry.status !== 204) throw new Error("UX evidence was not accepted.");
    durations.push(durationMs);
  }
  durations.sort((left, right) => left - right);
  const p75 = durations[Math.ceil(durations.length * 0.75) - 1];
  console.log(`${label} evidence: 20 measured interactions, p75 ${Math.round(p75 ?? 0)}ms.`);
  return { sinceMs: startedAtMs - 60_000, untilMs: Date.now() + 60_000 };
}

async function smoke(state: z.infer<typeof stateSchema>) {
  await assertDeployedVersion(state.publicUrl, state.investigatorReleaseId);
  for (const route of ["/app", "/investigator"]) {
    const response = await requestDeploymentEndpointOnce(
      async () => fetch(`${state.publicUrl}${route}`),
      `Public route ${route}`,
    );
    const body = await response.text();
    if (!body.includes("Regression Surgeon")) throw new Error(`${route} did not serve the app.`);
  }
  const runtime = await assertRuntimeAttribution(state);
  const smokeSession = `deployment-smoke-${crypto.randomUUID()}`;
  await waitForDeploymentEvidenceReady(
    async () =>
      fetch(
        `${state.publicUrl}/api/deployment-evidence-readiness?session=${encodeURIComponent(smokeSession)}`,
        {
          method: "GET",
          headers: { "x-deploy-smoke-key": state.smokeKey },
        },
      ),
    async () =>
      new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, deploymentEvidenceReadinessPolicy.delayMs),
      ),
  );
  await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 10_000));
  const smokeResponse = await requestDeploymentSmokeWithRetry(
    async () =>
      fetch(`${state.publicUrl}/api/deployment-smoke`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-deploy-smoke-key": state.smokeKey,
        },
        body: JSON.stringify({ session: smokeSession }),
      }),
    async () =>
      new Promise<void>((resolveDelay) =>
        setTimeout(resolveDelay, deploymentSmokeRetryPolicy.delayMs),
      ),
  );
  if (!smokeResponse.ok) {
    let failureBody: unknown;
    try {
      failureBody = await smokeResponse.json();
    } catch {
      failureBody = undefined;
    }
    throw new Error(deploymentSmokeFailureMessage(smokeResponse.status, failureBody));
  }
  const smokeResult = await smokeResponse.json();
  const returned = z.object({ verification: smokeVerificationReceiptSchema }).parse(smokeResult);
  const verification = returned.verification;
  if (
    verification.incident.incidentId !== state.incidentId ||
    verification.incident.baselineReleaseId !== state.baselineReleaseId ||
    verification.incident.degradedReleaseId !== state.degradedReleaseId ||
    verification.incident.traceWindow.sinceMs !== state.degradedSinceMs ||
    verification.incident.traceWindow.untilMs !== state.degradedUntilMs
  ) {
    throw new Error("Public smoke did not preserve the configured incident identity.");
  }
  console.log(
    `Public smoke passed at ${state.publicUrl}: routes, Workers AI mode, version ${runtime.versionId}, measured evidence IDs, ${verification.phases.length} exact evidence phases, structured report and fingerprint ${verification.remediation.fingerprint}, preview performed zero writes, production GitHub writes ${runtime.githubWriteEnabled ? "enabled" : "disabled"}.`,
  );
}

async function deploy() {
  run("wrangler", ["whoami"]);
  await ensureNamedAiGateway();
  run("pnpm", ["build"]);
  const stableVersionId = readWriteDisabledInvestigatorVersion();
  const databaseId = findOrCreateDatabase();
  run("wrangler", [
    "deploy",
    "--config",
    resolve(repositoryRoot, "workers/health-service/wrangler.jsonc"),
    "--strict",
  ]);

  writeConfig(
    buildPlatformDeploymentConfig({
      databaseId,
      repositoryRoot,
      stage: { kind: "baseline", gitSha: baselineGitSha },
    }),
  );
  run("wrangler", [
    "d1",
    "migrations",
    "apply",
    "regression-surgeon-telemetry",
    "--remote",
    "--config",
    configPath,
  ]);

  const state = await runWithFailClosedRollback(
    async () => {
      const baselineVersionId = uploadPlatformVersion(
        buildPlatformDeploymentConfig({
          databaseId,
          repositoryRoot,
          stage: { kind: "baseline", gitSha: baselineGitSha },
        }),
      );
      deployMeasuredVersion(stableVersionId, baselineVersionId);
      await assertDeployedVersion(
        platformPublicUrl,
        baselineVersionId,
        buildExactVersionHeaders(baselineVersionId),
      );
      await waitForVersionOverrideSettle();
      await seedMeasuredTraffic(platformPublicUrl, baselineVersionId, "baseline");

      const degradedVersionId = uploadPlatformVersion(
        buildPlatformDeploymentConfig({
          databaseId,
          repositoryRoot,
          stage: { kind: "regression", gitSha: regressionGitSha },
        }),
      );
      deployMeasuredVersion(stableVersionId, degradedVersionId);
      await assertDeployedVersion(
        platformPublicUrl,
        degradedVersionId,
        buildExactVersionHeaders(degradedVersionId),
      );
      await waitForVersionOverrideSettle();
      const degradedWindow = await seedMeasuredTraffic(
        platformPublicUrl,
        degradedVersionId,
        "degraded",
      );
      const deployedGitSha = capture("git", ["rev-parse", "HEAD"]).trim();
      prepareRemoteSourceEvidence(databaseId, degradedVersionId, deployedGitSha);
      const smokeKey = crypto.randomUUID();
      const investigatorConfig = buildPlatformDeploymentConfig({
        databaseId,
        repositoryRoot,
        stage: {
          kind: "investigator",
          incidentId: `review-${degradedVersionId}`,
          gitSha: deployedGitSha,
          baselineReleaseId: baselineVersionId,
          degradedReleaseId: degradedVersionId,
          degradedSinceMs: degradedWindow.sinceMs,
          degradedUntilMs: degradedWindow.untilMs,
          smokeKey,
          githubWriteEnabled: false,
          publicUsageMode: "rate-limited",
        },
      });
      const investigator = deployPlatformWithSmokeSecret(investigatorConfig, smokeKey);
      return stateSchema.parse({
        aiGatewayId: AI_GATEWAY_ID,
        databaseId,
        publicUrl: investigator.url,
        incidentId: `review-${degradedVersionId}`,
        baselineReleaseId: baselineVersionId,
        degradedReleaseId: degradedVersionId,
        degradedSinceMs: degradedWindow.sinceMs,
        degradedUntilMs: degradedWindow.untilMs,
        investigatorReleaseId: investigator.versionId,
        deployedGitSha,
        githubWriteEnabled: false,
        publicUsageMode: "rate-limited",
        smokeKey,
      });
    },
    smoke,
    async () => restoreWriteDisabledInvestigator(stableVersionId),
    "Normal deployment failed and the write-disabled investigator rollback could not be verified.",
  );
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
}

function deployRefreshedInvestigator(
  previous: z.infer<typeof refreshStateSchema>,
  deployedGitSha: string,
  githubWriteEnabled: boolean,
  publicUsageMode: "disabled" | "rate-limited",
) {
  const smokeKey = crypto.randomUUID();
  const investigatorConfig = buildPlatformDeploymentConfig({
    databaseId: previous.databaseId,
    repositoryRoot,
    stage: {
      kind: "investigator",
      incidentId: previous.incidentId,
      gitSha: deployedGitSha,
      baselineReleaseId: previous.baselineReleaseId,
      degradedReleaseId: previous.degradedReleaseId,
      degradedSinceMs: previous.degradedSinceMs,
      degradedUntilMs: previous.degradedUntilMs,
      smokeKey,
      githubWriteEnabled,
      publicUsageMode,
    },
  });
  const investigator = deployPlatformWithSmokeSecret(investigatorConfig, smokeKey);
  if (githubWriteEnabled) assertGitHubWriteSecret();
  const state = stateSchema.parse({
    ...previous,
    publicUrl: investigator.url,
    investigatorReleaseId: investigator.versionId,
    deployedGitSha,
    githubWriteEnabled,
    publicUsageMode,
    smokeKey,
  });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  return state;
}

async function refreshInvestigator(
  githubWriteEnabled = false,
  requestedPublicUsageMode?: "disabled" | "rate-limited",
) {
  run("wrangler", ["whoami"]);
  await ensureNamedAiGateway();
  if (githubWriteEnabled) assertGitHubWriteSecret();
  run("pnpm", ["build"]);
  const previous = refreshStateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
  const publicUsageMode = requestedPublicUsageMode ?? previous.publicUsageMode;
  const deployedGitSha = capture("git", ["rev-parse", "HEAD"]).trim();
  prepareRemoteSourceEvidence(previous.databaseId, previous.degradedReleaseId, deployedGitSha);
  if (!githubWriteEnabled) {
    await smoke(deployRefreshedInvestigator(previous, deployedGitSha, false, publicUsageMode));
    return;
  }
  await runWithFailClosedRollback(
    async () => deployRefreshedInvestigator(previous, deployedGitSha, true, publicUsageMode),
    smoke,
    async () => {
      const rollbackState = deployRefreshedInvestigator(
        previous,
        deployedGitSha,
        false,
        publicUsageMode,
      );
      await assertRuntimeAttribution(rollbackState);
      console.error(
        "Write enablement failed; the public runtime was rolled back to writes disabled.",
      );
    },
  );
}

function resetRemoteEvidence() {
  const state = stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8")));
  writeConfig(
    buildPlatformDeploymentConfig({
      databaseId: state.databaseId,
      repositoryRoot,
      stage: {
        kind: "investigator",
        incidentId: state.incidentId,
        gitSha: state.deployedGitSha,
        baselineReleaseId: state.baselineReleaseId,
        degradedReleaseId: state.degradedReleaseId,
        degradedSinceMs: state.degradedSinceMs,
        degradedUntilMs: state.degradedUntilMs,
        smokeKey: state.smokeKey,
        githubWriteEnabled: state.githubWriteEnabled,
        publicUsageMode: state.publicUsageMode,
      },
    }),
  );
  run("wrangler", [
    "d1",
    "execute",
    "regression-surgeon-telemetry",
    "--remote",
    "--config",
    configPath,
    "--command",
    buildEvidenceResetSql(state.baselineReleaseId, state.degradedReleaseId),
  ]);
  console.log("Removed only the two measured deployment evidence sets from remote D1.");
}

const action = process.argv[2] ?? "deploy";
if (action === "deploy") await deploy();
else if (action === "refresh") await refreshInvestigator(false);
else if (action === "enable-writes") await refreshInvestigator(true);
else if (action === "disable-writes") await refreshInvestigator(false);
else if (action === "enable-usage") await refreshInvestigator(false, "rate-limited");
else if (action === "disable-usage") await refreshInvestigator(false, "disabled");
else if (action === "reset") resetRemoteEvidence();
else if (action === "gateway") {
  run("wrangler", ["whoami"]);
  await ensureNamedAiGateway();
  console.log(`AI Gateway ${AI_GATEWAY_ID} is ready.`);
} else if (action === "smoke")
  await smoke(stateSchema.parse(JSON.parse(readFileSync(statePath, "utf8"))));
else
  throw new Error(
    "Usage: node scripts/deploy.ts <deploy|refresh|enable-writes|disable-writes|enable-usage|disable-usage|reset|smoke|gateway>",
  );
