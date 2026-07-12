import { describe, expect, it } from "vitest";

import {
  compareReleaseSamples,
  nearestRankPercentile,
  summarizeSamples,
} from "../../packages/telemetry/src/metrics";

describe("telemetry metrics", () => {
  it("uses milliseconds and handles empty, singleton, and percentile boundaries", () => {
    expect(nearestRankPercentile([], 0.75)).toBeNull();
    expect(nearestRankPercentile([125], 0.75)).toBe(125);
    expect(nearestRankPercentile([10, 20, 30, 40], 0.5)).toBe(20);
    expect(nearestRankPercentile([10, 20, 30, 40], 0.75)).toBe(30);
    expect(nearestRankPercentile([10, 20, 30, 40], 0.95)).toBe(40);
  });

  it("summarizes latency and error outcomes without converting units", () => {
    expect(
      summarizeSamples([
        { durationMs: 100, outcome: "success" },
        { durationMs: 200, outcome: "error" },
        { durationMs: 300, outcome: "partial" },
        { durationMs: 400, outcome: "success" },
      ]),
    ).toEqual({
      sampleCount: 4,
      p50Ms: 200,
      p75Ms: 300,
      p95Ms: 400,
      errorRate: 0.25,
    });
  });

  it("requires minimum samples in both equivalent release windows", () => {
    const insufficient = compareReleaseSamples({
      baseline: [{ durationMs: 100, outcome: "success" }],
      current: [{ durationMs: 200, outcome: "success" }],
      minimumSamples: 2,
      windowDurationMs: 60_000,
    });
    expect(insufficient).toEqual({
      status: "insufficient-data",
      baselineSampleCount: 1,
      currentSampleCount: 1,
      minimumSamples: 2,
      windowDurationMs: 60_000,
    });

    const ready = compareReleaseSamples({
      baseline: [
        { durationMs: 100, outcome: "success" },
        { durationMs: 120, outcome: "success" },
      ],
      current: [
        { durationMs: 300, outcome: "success" },
        { durationMs: 360, outcome: "error" },
      ],
      minimumSamples: 2,
      windowDurationMs: 60_000,
    });
    expect(ready).toMatchObject({
      status: "ready",
      windowDurationMs: 60_000,
      baseline: { p75Ms: 120, errorRate: 0 },
      current: { p75Ms: 360, errorRate: 0.5 },
      p75DeltaMs: 240,
      p75DeltaRatio: 2,
    });
  });

  it("rejects invalid durations, outcomes, percentiles, and comparison policy", () => {
    expect(() => nearestRankPercentile([1], 0)).toThrow();
    expect(() => nearestRankPercentile([-1], 0.75)).toThrow();
    expect(() => summarizeSamples([{ durationMs: Number.NaN, outcome: "success" }])).toThrow();
    expect(() =>
      compareReleaseSamples({
        baseline: [],
        current: [],
        minimumSamples: 0,
        windowDurationMs: 60_000,
      }),
    ).toThrow();
  });
});
