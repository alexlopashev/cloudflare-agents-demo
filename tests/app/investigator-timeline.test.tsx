import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildToolTimeline, ToolTimeline } from "../../apps/web/src/investigator/ToolTimeline";

const messages = [
  {
    id: "assistant-1",
    parts: [
      {
        type: "tool-compare_releases",
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
      {
        type: "tool-create_draft_pr",
        state: "approval-requested",
        toolCallId: "call-4",
      },
    ],
  },
];

describe("investigator tool timeline", () => {
  it("projects ordered, bounded tool status without leaking raw errors", () => {
    expect(buildToolTimeline(messages)).toEqual([
      {
        id: "assistant-1-call-1",
        label: "Compare releases",
        state: "completed",
        summary: "Evidence received",
      },
      {
        id: "assistant-1-call-2",
        label: "Inspect release",
        state: "failed",
        summary: "Evidence incomplete (bounded result)",
      },
      {
        id: "assistant-1-call-3",
        label: "Read repository files",
        state: "failed",
        summary: "Evidence lookup failed",
      },
      {
        id: "assistant-1-call-4",
        label: "Create draft PR",
        state: "running",
        summary: "Awaiting human approval",
      },
    ]);
    expect(JSON.stringify(buildToolTimeline(messages))).not.toContain("private");
  });

  it("renders an accessible ordered timeline", () => {
    const markup = renderToStaticMarkup(<ToolTimeline entries={buildToolTimeline(messages)} />);

    expect(markup).toContain('aria-label="Investigation tool timeline"');
    expect(markup).toContain("Compare releases");
    expect(markup).toContain("Inspect release");
    expect(markup).toContain("Read repository files");
    expect(markup).toContain("Create draft PR");
    expect(markup.indexOf("Compare releases")).toBeLessThan(markup.indexOf("Inspect release"));
  });
});
