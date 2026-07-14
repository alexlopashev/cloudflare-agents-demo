import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  buildDeploymentInteractionId,
  buildPlatformDeploymentConfig,
  buildEvidenceResetSql,
  buildConfiguredSourceEvidence,
  buildConfiguredPreviewEvidence,
  buildReleaseSourceEvidenceSql,
  buildReleasePreviewEvidenceSql,
  deploymentSmokeRetryPolicy,
  deploymentVersionPropagationPolicy,
  deploymentSmokeFailureMessage,
  parseD1DatabaseId,
  parseDeploymentResult,
  parseGitHubWriteSecretInventory,
  requestDeploymentEndpointOnce,
  requestDeploymentSmokeWithRetry,
  runtimeAttributionRetryPolicy,
  runWithFailClosedRollback,
  waitForDeploymentVersion,
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
    expect(deployScript).toContain(
      "buildDeploymentInteractionId(label, expectedReleaseId, sample + 1)",
    );
    expect(deployScript).toContain("await assertDeployedVersion(baseline.url, baseline.versionId)");
    expect(deployScript).toContain("await assertDeployedVersion(degraded.url, degraded.versionId)");
    expect(deployScript).toContain(
      "await assertDeployedVersion(state.publicUrl, state.investigatorReleaseId)",
    );
    expect(deployScript).toContain(
      '"content-type": "application/vnd.regression-surgeon.deployment-health+json"',
    );
    expect(deployScript).toContain('"x-deployment-expected-release": expectedReleaseId');
    expect(
      deployScript.match(/if \(githubWriteEnabled\) assertGitHubWriteSecret\(\);/g),
    ).toHaveLength(2);
    expect(deployScript).toContain("runtimeAttributionRetryPolicy.maxAttempts");
    expect(deployScript).toContain("runtimeAttributionRetryPolicy.delayMs");
    expect(deployScript.match(/prepareRemoteSourceEvidence\(/g)).toHaveLength(3);
    expect(deployScript).toContain('"migrations",\n    "apply"');
    expect(deployScript).toContain('"--file",\n      sourceEvidencePath');
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

  it("scopes every measured interaction to its immutable release", () => {
    const firstRelease = buildDeploymentInteractionId("baseline", baselineVersionId, 1);
    const secondRelease = buildDeploymentInteractionId("baseline", degradedVersionId, 1);

    expect(firstRelease).toBe(`baseline-${baselineVersionId}-01`);
    expect(secondRelease).toBe(`baseline-${degradedVersionId}-01`);
    expect(secondRelease).not.toBe(firstRelease);
    expect(buildDeploymentInteractionId("degraded", degradedVersionId, 20)).toBe(
      `degraded-${degradedVersionId}-20`,
    );
    expect(() => buildDeploymentInteractionId("baseline", baselineVersionId, 0)).toThrow(
      /sample number/i,
    );
    expect(() => buildDeploymentInteractionId("baseline", baselineVersionId, 21)).toThrow(
      /sample number/i,
    );
    expect(() => buildDeploymentInteractionId("baseline", "not-a-version", 1)).toThrow(
      /release identifier/i,
    );
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

  it("surfaces only bounded incomplete evidence phase diagnostics", () => {
    const message = deploymentSmokeFailureMessage(422, {
      error: {
        code: "incomplete-evidence-receipt",
        phases: [
          { toolName: "compare_releases", status: "complete" },
          { toolName: "find_slow_traces", status: "complete" },
          { toolName: "inspect_trace", status: "complete" },
          { toolName: "inspect_release", status: "error", reason: "rate-limited" },
          { toolName: "read_repo_files", status: "pending" },
        ],
      },
    });

    expect(message).toBe(
      "Public agent smoke returned HTTP 422: incomplete-evidence-receipt (inspect_release=error:rate-limited, read_repo_files=pending).",
    );
    expect(
      deploymentSmokeFailureMessage(500, {
        error: "secret model prose",
        token: "credential-must-not-surface",
      }),
    ).toBe("Public agent smoke returned HTTP 500.");
  });

  it("distinguishes whitelisted invalid receipt fields from missing preparation", () => {
    const message = deploymentSmokeFailureMessage(422, {
      error: {
        code: "invalid-evidence-receipt",
        phases: [],
        invalidFields: ["receipt-phases"],
      },
    });

    expect(message).toBe(
      "Public agent smoke returned HTTP 422: invalid-evidence-receipt (invalid fields: receipt-phases).",
    );
    expect(message).not.toContain("private");
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

  it("polls only immutable version identity before measured traffic", async () => {
    const versions = [
      baselineVersionId,
      degradedVersionId,
      baselineVersionId,
      baselineVersionId,
      baselineVersionId,
    ];
    const readVersion = vi.fn(async () => versions.shift());
    const wait = vi.fn(async () => undefined);

    await expect(
      waitForDeploymentVersion(readVersion, baselineVersionId, wait),
    ).resolves.toBeUndefined();
    expect(readVersion).toHaveBeenCalledTimes(5);
    expect(wait).toHaveBeenCalledTimes(4);
    expect(deploymentVersionPropagationPolicy.consecutiveMatches).toBe(3);

    const staleVersion = vi.fn(async () => degradedVersionId);
    const boundedWait = vi.fn(async () => undefined);
    await expect(
      waitForDeploymentVersion(staleVersion, baselineVersionId, boundedWait),
    ).rejects.toThrow(/did not reach the public edge/i);
    expect(staleVersion).toHaveBeenCalledTimes(deploymentVersionPropagationPolicy.maxAttempts);
    expect(boundedWait).toHaveBeenCalledTimes(deploymentVersionPropagationPolicy.maxAttempts - 1);
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
    expect(sql).toContain("DELETE FROM release_source_evidence");
    expect(sql).toContain("DELETE FROM release_preview_evidence");
    expect(sql).toContain("DELETE FROM releases");
    expect(() => buildEvidenceResetSql("'; DROP TABLE releases; --", degradedVersionId)).toThrow(
      /version identifier/i,
    );
  });

  it("validates immutable local Git source proof and builds one escaped idempotent seed", () => {
    const evidence = buildConfiguredSourceEvidence({
      releaseId: degradedVersionId,
      regression: {
        sha: "d591869a8ef995f1835ef80152f4de085b10255b",
        subject: "perf: serialize health checks to limit pressure (#19)",
        committedAt: "2026-07-12T01:42:21.000Z",
        content: "sequential\n",
        blobSha: "58477bb417f47e0edf26725e9638e781b69f124c",
      },
      head: {
        sha: "9af361e5a9420323b2c86f2670e3bf812ac58620",
        content: "sequential\n",
        blobSha: "58477bb417f47e0edf26725e9638e781b69f124c",
      },
      base: {
        sha: "cf25e5253b106b1e7514340abe94bd42fd748725",
        content: "concurrent\n",
        blobSha: "e4d7bdcbdb49617abea9e6f4678a4ea92af3a6d3",
      },
    });

    expect(evidence).toMatchObject({
      releaseId: degradedVersionId,
      pullRequestNumber: 19,
      sourcePath: "workers/platform/src/api/health.ts",
      byteLength: 11,
    });
    const sql = buildReleaseSourceEvidenceSql({
      ...evidence,
      commitSubject: "perf: serialize 'quoted' health checks (#19)",
    });
    expect(sql).toContain("INSERT INTO release_source_evidence");
    expect(sql).toContain("serialize ''quoted'' health checks");
    expect(sql).toContain("ON CONFLICT (release_id) DO UPDATE SET");
    expect(sql).not.toContain("DROP TABLE");

    expect(() =>
      buildConfiguredSourceEvidence({
        releaseId: degradedVersionId,
        regression: {
          sha: evidence.commitSha,
          subject: evidence.commitSubject,
          committedAt: evidence.committedAt,
          content: evidence.content,
          blobSha: evidence.blobSha,
        },
        head: {
          sha: evidence.pullRequestHeadSha,
          content: "different\n",
          blobSha: "8baef1b4abc478178b004d62031cf7fe6db6f903",
        },
        base: {
          sha: "cf25e5253b106b1e7514340abe94bd42fd748725",
          content: "concurrent\n",
          blobSha: "e4d7bdcbdb49617abea9e6f4678a4ea92af3a6d3",
        },
      }),
    ).toThrow(/source proof/i);
  });

  it("validates one immutable deployed-main preview source and builds its bounded seed", () => {
    const preview = buildConfiguredPreviewEvidence({
      releaseId: degradedVersionId,
      source: {
        sha: "a".repeat(40),
        content: "sequential\n",
        blobSha: "58477bb417f47e0edf26725e9638e781b69f124c",
      },
      evidenced: {
        content: "sequential\n",
        blobSha: "58477bb417f47e0edf26725e9638e781b69f124c",
      },
    });
    expect(preview).toMatchObject({
      releaseId: degradedVersionId,
      baseSha: "a".repeat(40),
      sourcePath: "workers/platform/src/api/health.ts",
      byteLength: 11,
    });
    const sql = buildReleasePreviewEvidenceSql(preview);
    expect(sql).toContain("INSERT INTO release_preview_evidence");
    expect(sql).toContain("ON CONFLICT (release_id, base_sha) DO UPDATE SET");
    expect(sql).toContain("DELETE FROM release_preview_evidence");
    expect(sql).toContain(`base_sha <> '${"a".repeat(40)}'`);

    expect(() =>
      buildConfiguredPreviewEvidence({
        releaseId: degradedVersionId,
        source: {
          sha: "a".repeat(40),
          content: "changed\n",
          blobSha: "21fb1eca31e64cd3914025058b21992ab76edcf9",
        },
        evidenced: {
          content: "sequential\n",
          blobSha: "58477bb417f47e0edf26725e9638e781b69f124c",
        },
      }),
    ).toThrow(/preview proof/i);
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
