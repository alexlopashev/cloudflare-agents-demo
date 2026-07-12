import { afterEach, describe, expect, it, vi } from "vitest";

import { generateRegressionScenario } from "../../workers/platform/src/scenario/generator";
import type { SpanRecord, TraceRecord } from "../../workers/platform/src/telemetry/store";

const goodSha = "cf25e5253b106b1e7514340abe94bd42fd748725";
const badSha = "0123456789abcdef0123456789abcdef01234567";

describe("controlled regression scenario", () => {
  afterEach(() => vi.useRealTimers());

  it("distinguishes concurrent and sequential releases only through measured service traffic", async () => {
    vi.useFakeTimers({ now: 10_000 });
    const traces: { trace: TraceRecord; spans: readonly SpanRecord[] }[] = [];
    const store = {
      recordTrace: vi.fn(async (input) => {
        traces.push({ trace: input.trace, spans: input.spans });
      }),
      recordUxEvent: vi.fn(async () => undefined),
    };
    let traceSequence = 0;
    const scenarioPromise = generateRegressionScenario({
      badGitSha: badSha,
      createTraceId: () => `trace-${++traceSequence}`,
      fetcher: async (request) => {
        await new Promise((resolve) => setTimeout(resolve, 120));
        return Response.json({
          serviceId: request.headers.get("x-service-id"),
          status: "healthy",
        });
      },
      goodGitSha: goodSha,
      now: Date.now,
      sampleCount: 1,
      store,
    });

    await vi.runAllTimersAsync();
    const result = await scenarioPromise;

    expect(result).toEqual({
      baselineReleaseId: "baseline-concurrent",
      degradedReleaseId: "regression-sequential",
      sampleCount: 1,
    });
    expect(traces.map(({ trace }) => trace.durationMs)).toEqual([120, 360]);
    expect(traces.map(({ trace }) => trace.releaseId)).toEqual([
      "baseline-concurrent",
      "regression-sequential",
    ]);
    const baselineServiceStarts = traces[0]?.spans.slice(1).map((span) => span.startedAtMs);
    const degradedServiceStarts = traces[1]?.spans.slice(1).map((span) => span.startedAtMs);
    expect(new Set(baselineServiceStarts).size).toBe(1);
    expect(degradedServiceStarts).toEqual([
      1_700_086_401_000, 1_700_086_401_120, 1_700_086_401_240,
    ]);
    expect(store.recordUxEvent).toHaveBeenCalledTimes(2);
  });

  it("rejects unbounded samples and invalid release SHAs before traffic", async () => {
    const fetcher = vi.fn(async () => new Response());
    const store = {
      recordTrace: vi.fn(async () => undefined),
      recordUxEvent: vi.fn(async () => undefined),
    };
    const base = {
      badGitSha: badSha,
      createTraceId: () => "trace-1",
      fetcher,
      goodGitSha: goodSha,
      now: Date.now,
      store,
    };

    await expect(generateRegressionScenario({ ...base, sampleCount: 0 })).rejects.toThrow();
    await expect(
      generateRegressionScenario({ ...base, goodGitSha: "not-a-sha", sampleCount: 1 }),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
