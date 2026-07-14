import { describe, expect, it, vi } from "vitest";

import { createInvestigationTools } from "../../workers/platform/src/agent/tools";

type ExecutableTool = {
  execute?: (input: never, options: never) => unknown;
};

async function execute(tool: ExecutableTool | undefined, input: unknown) {
  if (!tool?.execute) throw new Error("fixture tool is not executable");
  return tool.execute(input as never, {} as never);
}

function services() {
  return {
    telemetry: {
      compareReleases: vi.fn(async (input) => ({ kind: "comparison", input })),
      findSlowTraces: vi.fn(async (input) => [{ kind: "slow", input }]),
      getTraceDetail: vi.fn(async (traceId) => ({ kind: "trace", traceId })),
    },
    repository: {
      inspectRelease: vi.fn(async (versionId) => ({ kind: "release", versionId })),
      readFiles: vi.fn(async (input) => [{ path: input.paths[0], content: "source" }]),
    },
  };
}

describe("investigation tools", () => {
  it("exposes only five single-purpose evidence capabilities", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence);

    expect(Object.keys(tools)).toEqual([
      "compare_releases",
      "find_slow_traces",
      "inspect_trace",
      "inspect_release",
      "read_repo_files",
    ]);
    await expect(
      execute(tools.compare_releases, {
        baselineReleaseId: "baseline-concurrent",
        candidateReleaseId: "regression-sequential",
        windowMs: 60_000,
      }),
    ).resolves.toMatchObject({ kind: "comparison" });
    await execute(tools.find_slow_traces, {
      sinceMs: 1,
      untilMs: 2,
      limit: 10,
    });
    await execute(tools.inspect_trace, { traceId: "trace-1" });

    expect(evidence.telemetry.compareReleases).toHaveBeenCalledOnce();
    expect(evidence.telemetry.findSlowTraces).toHaveBeenCalledOnce();
    expect(evidence.telemetry.getTraceDetail).toHaveBeenCalledExactlyOnceWith("trace-1");
  });

  it("rejects arbitrary SQL and out-of-policy queries before calling evidence sources", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence);

    await expect(
      execute(tools.compare_releases, {
        baselineReleaseId: "baseline-concurrent",
        candidateReleaseId: "regression-sequential",
        windowMs: 60_000,
        sql: "SELECT * FROM releases",
      }),
    ).rejects.toThrow();
    await expect(
      execute(tools.find_slow_traces, {
        sinceMs: 0,
        untilMs: 1,
        limit: 101,
      }),
    ).rejects.toThrow();
    expect(evidence.telemetry.findSlowTraces).not.toHaveBeenCalled();
  });

  it("uses only server-authoritative selectors for the active incident", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence, {
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
        traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
      },
    });

    await execute(tools.compare_releases, {
      baselineReleaseId: "generated-current-release",
      candidateReleaseId: "generated-candidate-release",
      windowMs: 60_000,
    });
    await execute(tools.find_slow_traces, {
      releaseId: "generated-current-release",
      sinceMs: 1_001,
      untilMs: 2_001,
      limit: 4,
    });
    await execute(tools.inspect_release, { versionId: "generated-current-release" });

    expect(evidence.telemetry.compareReleases).toHaveBeenCalledExactlyOnceWith({
      baselineReleaseId: "baseline-concurrent",
      candidateReleaseId: "regression-sequential",
      windowMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(evidence.telemetry.findSlowTraces).toHaveBeenCalledExactlyOnceWith({
      releaseId: "regression-sequential",
      sinceMs: 1_000,
      untilMs: 2_000,
      limit: 5,
    });
    expect(evidence.repository.inspectRelease).toHaveBeenCalledExactlyOnceWith(
      "regression-sequential",
    );
  });

  it("does not require the model to repeat configured selectors", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence, {
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
        traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
      },
    });

    await execute(tools.compare_releases, {});
    await execute(tools.find_slow_traces, {});
    await execute(tools.inspect_release, {});

    expect(evidence.telemetry.compareReleases).toHaveBeenCalledExactlyOnceWith({
      baselineReleaseId: "baseline-concurrent",
      candidateReleaseId: "regression-sequential",
      windowMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(evidence.telemetry.findSlowTraces).toHaveBeenCalledExactlyOnceWith({
      releaseId: "regression-sequential",
      sinceMs: 1_000,
      untilMs: 2_000,
      limit: 5,
    });
    expect(evidence.repository.inspectRelease).toHaveBeenCalledExactlyOnceWith(
      "regression-sequential",
    );
  });

  it("inspects the receipt-selected trace instead of a model-generated trace identifier", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence, {
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
        traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
      },
      selectedTraceId: () => "readiness-proven-trace",
    });

    await execute(tools.inspect_trace, { traceId: "model-generated-trace" });

    expect(evidence.telemetry.getTraceDetail).toHaveBeenCalledExactlyOnceWith(
      "readiness-proven-trace",
    );
  });

  it("ignores malformed model selectors for every configured evidence phase", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence, {
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
        traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
      },
      selectedTraceId: () => "receipt-trace",
      selectedSource: () => ({
        commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
        path: "workers/platform/src/api/health.ts",
      }),
    });

    await execute(tools.compare_releases, { sql: "private", windowMs: "all" });
    await execute(tools.find_slow_traces, { releaseId: 42, limit: "all" });
    await execute(tools.inspect_trace, { traceId: 42, repository: "other/repo" });
    await execute(tools.inspect_release, { versionId: 42, path: "secrets" });
    await execute(tools.read_repo_files, { commitSha: "generated", paths: ["secrets"] });

    expect(evidence.telemetry.compareReleases).toHaveBeenCalledExactlyOnceWith({
      baselineReleaseId: "baseline-concurrent",
      candidateReleaseId: "regression-sequential",
      windowMs: 30 * 24 * 60 * 60 * 1_000,
    });
    expect(evidence.telemetry.findSlowTraces).toHaveBeenCalledExactlyOnceWith({
      releaseId: "regression-sequential",
      sinceMs: 1_000,
      untilMs: 2_000,
      limit: 5,
    });
    expect(evidence.telemetry.getTraceDetail).toHaveBeenCalledExactlyOnceWith("receipt-trace");
    expect(evidence.repository.inspectRelease).toHaveBeenCalledExactlyOnceWith(
      "regression-sequential",
    );
    expect(evidence.repository.readFiles).toHaveBeenCalledExactlyOnceWith({
      commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
      paths: ["workers/platform/src/api/health.ts"],
    });
    expect(JSON.stringify(evidence.repository.readFiles.mock.calls)).not.toContain("secrets");
  });

  it("distinguishes absent receipt selectors from evidence service unavailability", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence, {
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
        traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
      },
      selectedTraceId: () => undefined,
      selectedSource: () => undefined,
    });

    await expect(execute(tools.inspect_trace, {})).resolves.toEqual({
      status: "error",
      code: "invalid-input",
      message: "Configured evidence selector is unavailable.",
    });
    await expect(execute(tools.read_repo_files, {})).resolves.toEqual({
      status: "error",
      code: "invalid-input",
      message: "Configured evidence selector is unavailable.",
    });
    expect(evidence.telemetry.getTraceDetail).not.toHaveBeenCalled();
    expect(evidence.repository.readFiles).not.toHaveBeenCalled();
  });

  it("truncates oversized tool results deterministically before model context", async () => {
    const evidence = services();
    evidence.repository.readFiles.mockResolvedValue([
      { path: "workers/platform/src/api/health.ts", content: "x".repeat(10_000) },
    ]);
    const tools = createInvestigationTools(evidence, { maxResultBytes: 512 });

    const first = await execute(tools.read_repo_files, {
      commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
      paths: ["workers/platform/src/api/health.ts"],
    });
    const second = await execute(tools.read_repo_files, {
      commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
      paths: ["workers/platform/src/api/health.ts"],
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({ status: "truncated", originalBytes: expect.any(Number) });
    expect(new TextEncoder().encode(JSON.stringify(first)).byteLength).toBeLessThanOrEqual(512);
  });

  it("turns unknown failures into bounded model-visible errors without private details", async () => {
    const evidence = services();
    evidence.repository.inspectRelease.mockRejectedValue(new Error("private token and stack"));
    const tools = createInvestigationTools(evidence);

    const result = await execute(tools.inspect_release, { versionId: "regression-sequential" });

    expect(result).toEqual({
      status: "error",
      code: "unavailable",
      message: "Evidence source is unavailable.",
    });
    expect(JSON.stringify(result)).not.toContain("private");
  });
});
