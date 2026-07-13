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

  it("selects one deterministic branch from parallel siblings", () => {
    expect(
      calculateCriticalPath([
        span({ spanId: "root", durationMs: 120 }),
        span({ spanId: "jobs", parentSpanId: "root", durationMs: 120 }),
        span({ spanId: "api", parentSpanId: "root", durationMs: 120 }),
        span({ spanId: "storage", parentSpanId: "root", durationMs: 120 }),
      ]),
    ).toEqual({
      diagnostics: [],
      spanIds: ["root", "api"],
      wallTimeMs: 120,
    });
  });

  it("keeps sequential siblings and counts gaps as elapsed path wall time", () => {
    expect(
      calculateCriticalPath([
        span({ spanId: "root", durationMs: 360 }),
        span({ spanId: "api", parentSpanId: "root", durationMs: 100 }),
        span({ spanId: "jobs", parentSpanId: "root", startedAtMs: 140, durationMs: 100 }),
        span({ spanId: "storage", parentSpanId: "root", startedAtMs: 260, durationMs: 100 }),
      ]),
    ).toEqual({
      diagnostics: [],
      spanIds: ["root", "api", "jobs", "storage"],
      wallTimeMs: 360,
    });
  });

  it("keeps nested ancestry on the selected path", () => {
    expect(
      calculateCriticalPath([
        span({ spanId: "root", durationMs: 300 }),
        span({ spanId: "operation", parentSpanId: "root", startedAtMs: 20, durationMs: 200 }),
        span({ spanId: "query", parentSpanId: "operation", startedAtMs: 30, durationMs: 50 }),
      ]),
    ).toEqual({
      diagnostics: [],
      spanIds: ["root", "operation", "query"],
      wallTimeMs: 300,
    });
  });

  it("selects the longest fork before a later join", () => {
    expect(
      calculateCriticalPath([
        span({ spanId: "root", durationMs: 160 }),
        span({ spanId: "setup", parentSpanId: "root", durationMs: 20 }),
        span({ spanId: "short", parentSpanId: "root", startedAtMs: 20, durationMs: 80 }),
        span({ spanId: "long", parentSpanId: "root", startedAtMs: 20, durationMs: 100 }),
        span({ spanId: "join", parentSpanId: "root", startedAtMs: 120, durationMs: 40 }),
      ]),
    ).toEqual({
      diagnostics: [],
      spanIds: ["root", "setup", "long", "join"],
      wallTimeMs: 160,
    });
  });

  it("excludes malformed parentage from the path and returns stable diagnostics", () => {
    const spans = [
      span({ spanId: "root", durationMs: 100 }),
      span({ spanId: "orphan", parentSpanId: "missing", startedAtMs: 10, durationMs: 20 }),
      span({ spanId: "cycle-b", parentSpanId: "cycle-a", startedAtMs: 20, durationMs: 20 }),
      span({ spanId: "cycle-a", parentSpanId: "cycle-b", startedAtMs: 20, durationMs: 20 }),
    ];

    expect(calculateCriticalPath(spans)).toEqual({
      diagnostics: [
        { code: "cycle", spanIds: ["cycle-a", "cycle-b"] },
        { code: "missing-parent", parentSpanId: "missing", spanId: "orphan" },
      ],
      spanIds: ["root"],
      wallTimeMs: 100,
    });
    expect(buildTraceForest(spans)).toEqual([
      { children: [], span: span({ spanId: "root", durationMs: 100 }) },
      {
        children: [],
        missingParentSpanId: "missing",
        span: span({ spanId: "orphan", parentSpanId: "missing", startedAtMs: 10, durationMs: 20 }),
      },
      {
        children: [],
        cyclicParentSpanId: "cycle-b",
        span: span({ spanId: "cycle-a", parentSpanId: "cycle-b", startedAtMs: 20, durationMs: 20 }),
      },
      {
        children: [],
        cyclicParentSpanId: "cycle-a",
        span: span({ spanId: "cycle-b", parentSpanId: "cycle-a", startedAtMs: 20, durationMs: 20 }),
      },
    ]);
  });

  it("handles empty input and rejects duplicate identifiers and invalid clocks", () => {
    expect(calculateCriticalPath([])).toEqual({ diagnostics: [], spanIds: [], wallTimeMs: 0 });
    expect(calculateCriticalPath([span({ spanId: "zero", durationMs: 0 })])).toEqual({
      diagnostics: [],
      spanIds: ["zero"],
      wallTimeMs: 0,
    });
    expect(() => buildTraceForest([span({ spanId: "same" }), span({ spanId: "same" })])).toThrow();
    expect(() => calculateCriticalPath([span({ spanId: "bad", durationMs: -1 })])).toThrow();
  });
});
