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
  it("exposes only the three evidence capabilities and delegates fixed telemetry operations", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence);

    expect(Object.keys(tools)).toEqual(["query_telemetry", "inspect_release", "read_repo_files"]);
    await expect(
      execute(tools.query_telemetry, {
        operation: "compare-releases",
        baselineReleaseId: "baseline-concurrent",
        candidateReleaseId: "regression-sequential",
        windowMs: 60_000,
      }),
    ).resolves.toMatchObject({ kind: "comparison" });
    await execute(tools.query_telemetry, {
      operation: "find-slow-traces",
      sinceMs: 1,
      untilMs: 2,
      limit: 10,
    });
    await execute(tools.query_telemetry, { operation: "inspect-trace", traceId: "trace-1" });

    expect(evidence.telemetry.compareReleases).toHaveBeenCalledOnce();
    expect(evidence.telemetry.findSlowTraces).toHaveBeenCalledOnce();
    expect(evidence.telemetry.getTraceDetail).toHaveBeenCalledExactlyOnceWith("trace-1");
  });

  it("rejects arbitrary SQL and out-of-policy queries before calling evidence sources", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence);

    await expect(
      execute(tools.query_telemetry, { operation: "sql", sql: "SELECT * FROM releases" }),
    ).rejects.toThrow();
    await expect(
      execute(tools.query_telemetry, {
        operation: "find-slow-traces",
        sinceMs: 0,
        untilMs: 1,
        limit: 101,
      }),
    ).rejects.toThrow();
    expect(evidence.telemetry.findSlowTraces).not.toHaveBeenCalled();
  });

  it("rejects evidence queries outside the active incident reference", async () => {
    const evidence = services();
    const tools = createInvestigationTools(evidence, {
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
        traceWindow: { sinceMs: 1_000, untilMs: 2_000 },
      },
    });

    await expect(
      execute(tools.query_telemetry, {
        operation: "compare-releases",
        baselineReleaseId: "generated-current-release",
        candidateReleaseId: "regression-sequential",
        windowMs: 60_000,
      }),
    ).resolves.toEqual({
      status: "error",
      code: "incident-mismatch",
      message: "Evidence request does not match the configured incident.",
    });
    await expect(
      execute(tools.query_telemetry, {
        operation: "find-slow-traces",
        releaseId: "regression-sequential",
        sinceMs: 1_001,
        untilMs: 2_000,
        limit: 5,
      }),
    ).resolves.toMatchObject({ status: "error", code: "incident-mismatch" });
    await expect(
      execute(tools.inspect_release, { versionId: "generated-current-release" }),
    ).resolves.toMatchObject({ status: "error", code: "incident-mismatch" });
    expect(evidence.telemetry.compareReleases).not.toHaveBeenCalled();
    expect(evidence.telemetry.findSlowTraces).not.toHaveBeenCalled();
    expect(evidence.repository.inspectRelease).not.toHaveBeenCalled();
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
