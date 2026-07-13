import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { buildToolTimeline, ToolTimeline } from "../../apps/web/src/investigator/ToolTimeline";

const receipt = {
  investigationId: "investigation-1",
  phases: [
    { toolName: "compare_releases", status: "complete", attempts: [] },
    { toolName: "find_slow_traces", status: "insufficient", attempts: [] },
    { toolName: "inspect_trace", status: "pending", attempts: [] },
    { toolName: "inspect_release", status: "pending", attempts: [] },
    { toolName: "read_repo_files", status: "pending", attempts: [] },
  ],
} as const;

describe("investigator tool timeline", () => {
  it("projects all five ordered phases from the shared receipt", () => {
    expect(buildToolTimeline(receipt)).toEqual([
      {
        id: "investigation-1-compare_releases",
        label: "Compare releases",
        state: "completed",
        summary: "Evidence received",
      },
      {
        id: "investigation-1-find_slow_traces",
        label: "Find slow traces",
        state: "failed",
        summary: "Evidence incomplete (bounded result)",
      },
      {
        id: "investigation-1-inspect_trace",
        label: "Inspect trace",
        state: "running",
        summary: "Waiting for prior evidence",
      },
      {
        id: "investigation-1-inspect_release",
        label: "Inspect release",
        state: "running",
        summary: "Waiting for prior evidence",
      },
      {
        id: "investigation-1-read_repo_files",
        label: "Read repository files",
        state: "running",
        summary: "Waiting for prior evidence",
      },
    ]);
  });

  it("renders an accessible ordered timeline", () => {
    const markup = renderToStaticMarkup(<ToolTimeline entries={buildToolTimeline(receipt)} />);

    expect(markup).toContain('aria-label="Investigation tool timeline"');
    expect(markup).toContain("Compare releases");
    expect(markup).toContain("Inspect release");
    expect(markup).toContain("Read repository files");
    expect(markup.indexOf("Compare releases")).toBeLessThan(markup.indexOf("Inspect release"));
  });
});
