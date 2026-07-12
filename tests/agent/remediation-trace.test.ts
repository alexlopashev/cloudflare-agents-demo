import { describe, expect, it } from "vitest";

import { findRepresentativeTraceId } from "../../workers/platform/src/agent/evidence-identifiers";

describe("remediation trace evidence", () => {
  it("reads the representative trace from structured inspect-trace input", () => {
    expect(
      findRepresentativeTraceId([
        { type: "tool-query_telemetry", input: { operation: "find-slow-traces", limit: 5 } },
        {
          type: "tool-query_telemetry",
          input: { operation: "inspect-trace", traceId: "trace-structured-1" },
        },
      ]),
    ).toBe("trace-structured-1");
  });

  it("ignores malformed or unrelated nested values", () => {
    expect(
      findRepresentativeTraceId({
        operation: "inspect-trace",
        traceId: "'; DROP TABLE traces; --",
        nested: { operation: "find-slow-traces", traceId: "trace-wrong" },
      }),
    ).toBeUndefined();
  });
});
