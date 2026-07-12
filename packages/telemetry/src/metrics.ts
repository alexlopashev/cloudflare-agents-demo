export type UxSample = {
  durationMs: number;
  outcome: "success" | "partial" | "error";
};

export type SampleSummary = {
  sampleCount: number;
  p50Ms: number | null;
  p75Ms: number | null;
  p95Ms: number | null;
  errorRate: number | null;
};

function requireDuration(value: number): number {
  if (!Number.isFinite(value) || value < 0)
    throw new TypeError("Duration must be finite milliseconds.");
  return value;
}

function requireSamples(samples: readonly UxSample[]): readonly UxSample[] {
  for (const sample of samples) {
    requireDuration(sample.durationMs);
    if (!(["success", "partial", "error"] as const).includes(sample.outcome)) {
      throw new TypeError("Sample outcome is invalid.");
    }
  }
  return samples;
}

export function nearestRankPercentile(
  values: readonly number[],
  percentile: number,
): number | null {
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new TypeError("Percentile must be greater than zero and at most one.");
  }
  for (const value of values) requireDuration(value);
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.ceil(percentile * sorted.length) - 1;
  return sorted[index] ?? null;
}

export function summarizeSamples(samples: readonly UxSample[]): SampleSummary {
  requireSamples(samples);
  const durations = samples.map((sample) => sample.durationMs);
  return {
    sampleCount: samples.length,
    p50Ms: nearestRankPercentile(durations, 0.5),
    p75Ms: nearestRankPercentile(durations, 0.75),
    p95Ms: nearestRankPercentile(durations, 0.95),
    errorRate:
      samples.length === 0
        ? null
        : samples.filter((sample) => sample.outcome === "error").length / samples.length,
  };
}

export function compareReleaseSamples(input: {
  baseline: readonly UxSample[];
  current: readonly UxSample[];
  minimumSamples: number;
  windowDurationMs: number;
}) {
  requireSamples(input.baseline);
  requireSamples(input.current);
  if (!Number.isSafeInteger(input.minimumSamples) || input.minimumSamples < 1) {
    throw new TypeError("Minimum sample count is invalid.");
  }
  requireDuration(input.windowDurationMs);
  if (input.windowDurationMs === 0) throw new TypeError("Comparison window must be positive.");

  if (input.baseline.length < input.minimumSamples || input.current.length < input.minimumSamples) {
    return {
      status: "insufficient-data" as const,
      baselineSampleCount: input.baseline.length,
      currentSampleCount: input.current.length,
      minimumSamples: input.minimumSamples,
      windowDurationMs: input.windowDurationMs,
    };
  }

  const baseline = summarizeSamples(input.baseline);
  const current = summarizeSamples(input.current);
  if (baseline.p75Ms === null || current.p75Ms === null) {
    throw new TypeError("Ready comparisons require latency samples.");
  }
  const p75DeltaMs = current.p75Ms - baseline.p75Ms;
  return {
    status: "ready" as const,
    windowDurationMs: input.windowDurationMs,
    baseline,
    current,
    p75DeltaMs,
    p75DeltaRatio: baseline.p75Ms === 0 ? null : p75DeltaMs / baseline.p75Ms,
  };
}
