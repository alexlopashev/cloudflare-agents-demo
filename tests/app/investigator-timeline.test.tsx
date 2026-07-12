import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildToolTimeline, ToolTimeline } from "../../apps/web/src/investigator/ToolTimeline";

const messages = [
  {
    id: "assistant-1",
    parts: [
      {
        type: "tool-query_telemetry",
        state: "output-available",
        toolCallId: "call-1",
        output: { status: "ready" },
      },
      {
        type: "tool-inspect_release",
        state: "output-available",
        toolCallId: "call-2",
        output: { status: "truncated" },
      },
      {
        type: "tool-read_repo_files",
        state: "output-error",
        toolCallId: "call-3",
        errorText: "private detail",
      },
    ],
  },
];

describe("investigator tool timeline", () => {
  it("projects ordered, bounded tool status without leaking raw errors", () => {
    expect(buildToolTimeline(messages)).toEqual([
      {
        id: "call-1",
        label: "Query telemetry",
        state: "completed",
        summary: "Evidence received",
      },
      {
        id: "call-2",
        label: "Inspect release",
        state: "completed",
        summary: "Evidence received (truncated to context limit)",
      },
      {
        id: "call-3",
        label: "Read repository files",
        state: "failed",
        summary: "Evidence lookup failed",
      },
    ]);
    expect(JSON.stringify(buildToolTimeline(messages))).not.toContain("private");
  });

  it("renders an accessible ordered timeline", () => {
    const markup = renderToStaticMarkup(<ToolTimeline entries={buildToolTimeline(messages)} />);

    expect(markup).toContain('aria-label="Investigation tool timeline"');
    expect(markup).toContain("Query telemetry");
    expect(markup).toContain("Inspect release");
    expect(markup).toContain("Read repository files");
    expect(markup.indexOf("Query telemetry")).toBeLessThan(markup.indexOf("Inspect release"));
  });
});
