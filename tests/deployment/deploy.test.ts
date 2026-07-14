import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildPlatformDeploymentConfig,
  buildEvidenceResetSql,
  deploymentSmokeRetryPolicy,
  parseD1DatabaseId,
  parseDeploymentResult,
  parseGitHubWriteSecretInventory,
  requestDeploymentEndpointOnce,
  requestDeploymentSmokeWithRetry,
  runtimeAttributionRetryPolicy,
  runWithFailClosedRollback,
  type DeploymentStage,
} from "../../scripts/deploy-lib.ts";

const root = "/workspace/cloudflare-agents-demo";
const databaseId = "11111111-2222-4333-8444-555555555555";
const baselineVersionId = "aaaaaaaa-2222-4333-8444-555555555555";
const degradedVersionId = "bbbbbbbb-2222-4333-8444-555555555555";
const incidentId = `review-${degradedVersionId}`;

function config(stage: DeploymentStage) {
  return buildPlatformDeploymentConfig({ databaseId, repositoryRoot: root, stage });
}

describe("Cloudflare deployment contract", () => {
  it("exposes unambiguous mise deployment entrypoints", () => {
    const mise = readFileSync(resolve(import.meta.dirname, "../../mise.toml"), "utf8");
    const deployScript = readFileSync(
      resolve(import.meta.dirname, "../../scripts/deploy.ts"),
      "utf8",
    );
    expect(mise).toContain('run = "pnpm run deploy"');
    expect(mise).toContain('run = "pnpm run deploy:smoke"');
    expect(mise).toContain(
      'run = "wrangler secret put GITHUB_TOKEN --name regression-surgeon-platform"',
    );
    expect(mise).toContain(
      'run = "wrangler secret delete GITHUB_TOKEN --name regression-surgeon-platform"',
    );
    expect(mise).toContain('run = "pnpm run deploy:writes:enable"');
    expect(mise).toContain('run = "pnpm run deploy:writes:disable"');
    expect(deployScript).toContain('"--secrets-file"');
    expect(deployScript).not.toContain('"secret", "put"');
    expect(deployScript).not.toContain("gh auth token");
    expect(deployScript).not.toContain("requestWithRetry");
    expect(deployScript.match(/await requestDeploymentEndpointOnce/g)).toHaveLength(3);
    expect(
      deployScript.match(/if \(githubWriteEnabled\) assertGitHubWriteSecret\(\);/g),
    ).toHaveLength(2);
    expect(deployScript).toContain("runtimeAttributionRetryPolicy.maxAttempts");
    expect(deployScript).toContain("runtimeAttributionRetryPolicy.delayMs");
    expect(
      runtimeAttributionRetryPolicy.maxAttempts * runtimeAttributionRetryPolicy.delayMs,
    ).toBeGreaterThanOrEqual(60_000);
  });

  it("builds measured baseline and regression stages against the real D1 database", () => {
    const baseline = config({ kind: "baseline", gitSha: "a".repeat(40) });
    const regression = config({ kind: "regression", gitSha: "b".repeat(40) });

    expect(baseline.d1_databases[0]?.database_id).toBe(databaseId);
    expect(baseline.vars).toMatchObject({
      GIT_SHA: "a".repeat(40),
      HEALTH_LOADING_MODE: "concurrent",
      MODEL_MODE: "workers-ai",
      GITHUB_WRITE_ENABLED: "false",
      SCENARIO_CONTROL_ENABLED: "false",
    });
    expect(regression.vars).toMatchObject({
      GIT_SHA: "b".repeat(40),
      HEALTH_LOADING_MODE: "sequential",
    });
  });

  it("injects measured version IDs into the public investigator while writes stay off", () => {
    const deployed = config({
      kind: "investigator",
      incidentId,
      gitSha: "c".repeat(40),
      baselineReleaseId: baselineVersionId,
      degradedReleaseId: degradedVersionId,
      degradedSinceMs: 1_783_840_086_000,
      degradedUntilMs: 1_783_840_100_000,
      smokeKey: "deployment-smoke-key-123456",
      githubWriteEnabled: false,
    });

    expect(deployed.vars).toMatchObject({
      EVIDENCE_INCIDENT_ID: incidentId,
      EVIDENCE_BASELINE_RELEASE_ID: baselineVersionId,
      EVIDENCE_DEGRADED_RELEASE_ID: degradedVersionId,
      EVIDENCE_DEGRADED_SINCE_MS: "1783840086000",
      EVIDENCE_DEGRADED_UNTIL_MS: "1783840100000",
      GITHUB_WRITE_ENABLED: "false",
      MODEL_MODE: "workers-ai",
      SCENARIO_CONTROL_ENABLED: "false",
    });
    expect(deployed.vars).not.toHaveProperty("DEPLOY_SMOKE_KEY");
    expect(deployed.main).toBe(`${root}/workers/platform/src/index.ts`);
    expect(deployed.assets.directory).toBe(`${root}/apps/web/dist/client`);
    expect(deployed.d1_databases[0]?.migrations_dir).toBe(`${root}/migrations/telemetry`);
  });

  it("enables writes only for an explicit investigator deployment", () => {
    const deployed = config({
      kind: "investigator",
      incidentId,
      gitSha: "c".repeat(40),
      baselineReleaseId: baselineVersionId,
      degradedReleaseId: degradedVersionId,
      degradedSinceMs: 1_783_840_086_000,
      degradedUntilMs: 1_783_840_100_000,
      smokeKey: "deployment-smoke-key-123456",
      githubWriteEnabled: true,
    });

    expect(deployed.vars.GITHUB_WRITE_ENABLED).toBe("true");
  });

  it("requires an exact remote GitHub token secret before enabling writes", () => {
    expect(
      parseGitHubWriteSecretInventory(
        JSON.stringify([
          { name: "DEPLOY_SMOKE_KEY", type: "secret_text" },
          { name: "GITHUB_TOKEN", type: "secret_text" },
        ]),
      ),
    ).toBe(true);
    expect(
      parseGitHubWriteSecretInventory(
        JSON.stringify([{ name: "DEPLOY_SMOKE_KEY", type: "secret_text" }]),
      ),
    ).toBe(false);
    expect(() => parseGitHubWriteSecretInventory("not-json")).toThrow(/secret inventory/i);
  });

  it("rolls a failed write enablement back and preserves the original failure", async () => {
    const enableFailure = new Error("Workers AI smoke failed");
    const rollback = vi.fn(async () => undefined);

    await expect(
      runWithFailClosedRollback(
        async () => ({ githubWriteEnabled: true }),
        async () => {
          throw enableFailure;
        },
        rollback,
      ),
    ).rejects.toBe(enableFailure);
    expect(rollback).toHaveBeenCalledOnce();
  });

  it("surfaces both enablement and rollback failures", async () => {
    const enableFailure = new Error("enabled deployment failed");
    const rollbackFailure = new Error("disabled deployment could not be verified");

    await expect(
      runWithFailClosedRollback(
        async () => {
          throw enableFailure;
        },
        async () => undefined,
        async () => {
          throw rollbackFailure;
        },
      ),
    ).rejects.toMatchObject({
      name: "AggregateError",
      errors: [enableFailure, rollbackFailure],
    });
  });

  it("retries only pre-execution 404s while a rotated smoke key propagates", async () => {
    const responses = [new Response(null, { status: 404 }), new Response(null, { status: 404 })];
    responses.push(new Response("ok", { status: 200 }));
    const request = vi.fn(async () => responses.shift() ?? new Response(null, { status: 500 }));
    const wait = vi.fn(async () => undefined);

    const response = await requestDeploymentSmokeWithRetry(request, wait);

    expect(response.status).toBe(200);
    expect(request).toHaveBeenCalledTimes(3);
    expect(wait).toHaveBeenCalledTimes(2);
  });

  it("never retries a smoke response that may follow endpoint execution", async () => {
    const request = vi.fn(async () => new Response(null, { status: 500 }));
    const wait = vi.fn(async () => undefined);

    const response = await requestDeploymentSmokeWithRetry(request, wait);

    expect(response.status).toBe(500);
    expect(request).toHaveBeenCalledOnce();
    expect(wait).not.toHaveBeenCalled();
  });

  it("attempts a side-effecting deployment endpoint exactly once", async () => {
    const successfulResponse = new Response(null, { status: 204 });
    const successfulRequest = vi.fn(async () => successfulResponse);
    await expect(
      requestDeploymentEndpointOnce(successfulRequest, "telemetry persistence"),
    ).resolves.toBe(successfulResponse);
    expect(successfulRequest).toHaveBeenCalledOnce();

    const responseFailure = vi.fn(async () => new Response(null, { status: 500 }));
    await expect(requestDeploymentEndpointOnce(responseFailure, "baseline health")).rejects.toThrow(
      /baseline health returned HTTP 500/i,
    );
    expect(responseFailure).toHaveBeenCalledOnce();

    const transportFailure = new Error("edge connection reset");
    const rejectedRequest = vi.fn(async () => {
      throw transportFailure;
    });
    await expect(
      requestDeploymentEndpointOnce(rejectedRequest, "telemetry persistence"),
    ).rejects.toThrow(/telemetry persistence failed before a response/i);
    expect(rejectedRequest).toHaveBeenCalledOnce();
  });

  it("bounds repeated propagation-only smoke responses", async () => {
    const request = vi.fn(async () => new Response(null, { status: 404 }));
    const wait = vi.fn(async () => undefined);

    const response = await requestDeploymentSmokeWithRetry(request, wait);

    expect(response.status).toBe(404);
    expect(request).toHaveBeenCalledTimes(deploymentSmokeRetryPolicy.maxAttempts);
    expect(wait).toHaveBeenCalledTimes(deploymentSmokeRetryPolicy.maxAttempts - 1);
  });

  it("parses existing/created D1 resources and Wrangler deployment evidence", () => {
    expect(
      parseD1DatabaseId(
        JSON.stringify([{ name: "regression-surgeon-telemetry", uuid: databaseId }]),
      ),
    ).toBe(databaseId);
    expect(parseD1DatabaseId(`database_id = "${databaseId}"`)).toBe(databaseId);
    expect(parseD1DatabaseId(`"database_id": "${databaseId}"`)).toBe(databaseId);
    expect(
      parseDeploymentResult(
        `Uploaded\nDeployed https://regression-surgeon.example.workers.dev\nVersion ID: ${databaseId}`,
      ),
    ).toEqual({
      url: "https://regression-surgeon.example.workers.dev",
      versionId: databaseId,
    });
  });

  it("builds a reset limited to the two measured release IDs", () => {
    const sql = buildEvidenceResetSql(baselineVersionId, degradedVersionId);
    expect(sql).toContain(`'${baselineVersionId}','${degradedVersionId}'`);
    expect(sql).toContain("DELETE FROM ux_events");
    expect(sql).toContain("DELETE FROM spans");
    expect(sql).toContain("DELETE FROM traces");
    expect(sql).toContain("DELETE FROM releases");
    expect(() => buildEvidenceResetSql("'; DROP TABLE releases; --", degradedVersionId)).toThrow(
      /version identifier/i,
    );
  });

  it("rejects missing or synthetic remote identifiers", () => {
    expect(() => parseD1DatabaseId("[]")).toThrow(/database identifier/i);
    expect(() => parseDeploymentResult("deploy complete")).toThrow(/deployment evidence/i);
    expect(() =>
      config({
        kind: "investigator",
        incidentId,
        gitSha: "c".repeat(40),
        baselineReleaseId: "regression-concurrent",
        degradedReleaseId: "regression-sequential",
        degradedSinceMs: 1,
        degradedUntilMs: 2,
        smokeKey: "deployment-smoke-key-123456",
        githubWriteEnabled: false,
      }),
    ).toThrow(/cloudflare version/i);
  });
});
