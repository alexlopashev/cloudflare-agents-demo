import { describe, expect, it, vi } from "vitest";

import {
  handleScenarioRequest,
  scenarioLocalKey,
} from "../../workers/platform/src/scenario/handler";

const goodGitSha = "cf25e5253b106b1e7514340abe94bd42fd748725";
const badGitSha = "0123456789abcdef0123456789abcdef01234567";

function request(path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-local-scenario-key": scenarioLocalKey,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function options() {
  const resetScenarioEvidence = vi.fn(async () => undefined);
  const generate = vi.fn(async () => ({
    baselineReleaseId: "baseline-concurrent" as const,
    degradedReleaseId: "regression-sequential" as const,
    sampleCount: 20,
  }));
  const compareReleases = vi.fn(async () => ({ status: "ready" as const }));
  const findSlowTraces = vi.fn(async () => [
    { traceId: "slow-trace", releaseId: "regression-sequential", durationMs: 360 },
  ]);
  const getTraceDetail = vi.fn(async () => ({
    criticalPath: { durationMs: 360, spanIds: ["service-api", "service-jobs", "service-storage"] },
  }));
  const investigate = vi.fn(async () => ({
    report: "## Evidence\nComplete",
    toolTypes: ["tool-query_telemetry", "tool-inspect_release", "tool-read_repo_files"],
  }));
  const previewRemediation = vi.fn(async () => ({
    status: "preview",
    writesPerformed: false,
    body: "## Evidence\nscenario-trace-34\n## Risk\n## Validation",
  }));
  return {
    options: {
      enabled: true,
      resetScenarioEvidence,
      generate,
      compareReleases,
      findSlowTraces,
      getTraceDetail,
      investigate,
      previewRemediation,
    },
    resetScenarioEvidence,
    generate,
    investigate,
    previewRemediation,
  };
}

describe("local scenario control", () => {
  it("resets and reseeds measured evidence idempotently through fixed operations", async () => {
    const fixture = options();
    const reset = await handleScenarioRequest(request("/api/scenario/reset"), fixture.options);
    const seeded = await handleScenarioRequest(
      request("/api/scenario/reseed", { goodGitSha, badGitSha }),
      fixture.options,
    );

    expect(reset.status).toBe(204);
    expect(seeded.status).toBe(200);
    expect(await seeded.json()).toEqual({
      scenario: {
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
        sampleCount: 20,
      },
      comparison: { status: "ready" },
      slowTrace: {
        criticalPath: {
          durationMs: 360,
          spanIds: ["service-api", "service-jobs", "service-storage"],
        },
        durationMs: 360,
        releaseId: "regression-sequential",
        traceId: "slow-trace",
      },
    });
    expect(fixture.resetScenarioEvidence).toHaveBeenCalledTimes(2);
    expect(fixture.generate).toHaveBeenCalledExactlyOnceWith({ goodGitSha, badGitSha });
    expect(fixture.options.findSlowTraces).toHaveBeenCalledExactlyOnceWith({
      releaseId: "regression-sequential",
      sinceMs: 1_700_000_000_000,
      untilMs: 1_700_086_460_000,
      limit: 10,
    });
  });

  it("stays invisible when disabled, deployed, unauthenticated, malformed, or off-route", async () => {
    const fixture = options();
    const disabled = await handleScenarioRequest(request("/api/scenario/reset"), {
      ...fixture.options,
      enabled: false,
    });
    const deployedRequest = new Request("https://example.workers.dev/api/scenario/reset", {
      method: "POST",
      headers: { "x-local-scenario-key": scenarioLocalKey },
    });
    const deployed = await handleScenarioRequest(deployedRequest, fixture.options);
    const unauthenticated = await handleScenarioRequest(
      new Request("http://localhost/api/scenario/reset", { method: "POST" }),
      fixture.options,
    );
    const malformed = await handleScenarioRequest(
      request("/api/scenario/reseed", { goodGitSha, badGitSha: "invalid" }),
      fixture.options,
    );
    const missing = await handleScenarioRequest(request("/api/scenario/unknown"), fixture.options);

    expect([disabled.status, deployed.status, unauthenticated.status, missing.status]).toEqual([
      404, 404, 404, 404,
    ]);
    expect(malformed.status).toBe(400);
    expect(fixture.generate).not.toHaveBeenCalled();
  });

  it("accepts loopback Miniflare requests even when local runtime metadata is present", async () => {
    const fixture = options();
    const localRequest = request("/api/scenario/reset");
    Object.defineProperty(localRequest, "cf", { value: { colo: "DEV" } });

    const response = await handleScenarioRequest(localRequest, fixture.options);

    expect(response.status).toBe(204);
  });

  it("runs the credential-free investigation through the local Think binding", async () => {
    const fixture = options();

    const response = await handleScenarioRequest(
      request("/api/scenario/investigate"),
      fixture.options,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      report: "## Evidence\nComplete",
      toolTypes: ["tool-query_telemetry", "tool-inspect_release", "tool-read_repo_files"],
    });
    expect(fixture.investigate).toHaveBeenCalledOnce();
  });

  it("returns a validated remediation preview without external writes", async () => {
    const fixture = options();

    const response = await handleScenarioRequest(
      request("/api/scenario/remediation-preview"),
      fixture.options,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: "preview",
      writesPerformed: false,
      body: "## Evidence\nscenario-trace-34\n## Risk\n## Validation",
    });
    expect(fixture.previewRemediation).toHaveBeenCalledOnce();
  });
});
