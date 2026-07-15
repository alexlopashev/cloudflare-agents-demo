import { describe, expect, it } from "vitest";

import { nearestRankPercentile, summarizeSamples } from "../../packages/telemetry/src/metrics";

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

  it("rejects invalid durations, outcomes, percentiles, and comparison policy", () => {
    expect(() => nearestRankPercentile([1], 0)).toThrow();
    expect(() => nearestRankPercentile([-1], 0.75)).toThrow();
    expect(() => summarizeSamples([{ durationMs: Number.NaN, outcome: "success" }])).toThrow();
  });
});
