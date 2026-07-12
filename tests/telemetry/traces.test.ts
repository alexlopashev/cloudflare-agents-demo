import { describe, expect, it } from "vitest";

import {
  buildTraceForest,
  calculateCriticalPath,
  type TraceSpan,
} from "../../packages/telemetry/src/traces";

function span(overrides: Partial<TraceSpan>): TraceSpan {
  return {
    spanId: "span-default",
    parentSpanId: null,
    serviceId: "api",
    startedAtMs: 0,
    durationMs: 100,
    status: "ok",
    ...overrides,
  };
}

describe("trace evidence", () => {
  it("builds stable parent-child trees and treats missing parents as explicit roots", () => {
    const forest = buildTraceForest([
      span({ spanId: "child", parentSpanId: "root", startedAtMs: 20 }),
      span({ spanId: "orphan", parentSpanId: "missing", startedAtMs: 5 }),
      span({ spanId: "root", startedAtMs: 0, durationMs: 200 }),
    ]);

    expect(forest).toEqual([
      {
        span: span({ spanId: "root", startedAtMs: 0, durationMs: 200 }),
        children: [
          { span: span({ spanId: "child", parentSpanId: "root", startedAtMs: 20 }), children: [] },
        ],
      },
      {
        span: span({ spanId: "orphan", parentSpanId: "missing", startedAtMs: 5 }),
        children: [],
        missingParentSpanId: "missing",
      },
    ]);
  });

  it("does not double-count overlapping spans and preserves sequential wall time", () => {
    const parallel = [
      span({ spanId: "api", startedAtMs: 0, durationMs: 120 }),
      span({ spanId: "jobs", startedAtMs: 0, durationMs: 120 }),
      span({ spanId: "storage", startedAtMs: 0, durationMs: 120 }),
    ];
    const sequential = parallel.map((item, index) => ({ ...item, startedAtMs: index * 120 }));

    expect(calculateCriticalPath(parallel)).toEqual({
      durationMs: 120,
      spanIds: ["api", "jobs", "storage"],
    });
    expect(calculateCriticalPath(sequential)).toEqual({
      durationMs: 360,
      spanIds: ["api", "jobs", "storage"],
    });
  });

  it("tolerates empty and late spans but rejects duplicates, cycles, and invalid clocks", () => {
    expect(calculateCriticalPath([])).toEqual({ durationMs: 0, spanIds: [] });
    expect(
      calculateCriticalPath([
        span({ spanId: "early", startedAtMs: 0, durationMs: 100 }),
        span({ spanId: "late", startedAtMs: 250, durationMs: 50 }),
      ]),
    ).toEqual({ durationMs: 150, spanIds: ["early", "late"] });

    expect(() => buildTraceForest([span({ spanId: "same" }), span({ spanId: "same" })])).toThrow();
    expect(() =>
      buildTraceForest([
        span({ spanId: "a", parentSpanId: "b" }),
        span({ spanId: "b", parentSpanId: "a" }),
      ]),
    ).toThrow();
    expect(() => calculateCriticalPath([span({ spanId: "bad", durationMs: -1 })])).toThrow();
  });
});
