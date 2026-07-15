import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildInvestigationEvents,
  InvestigationProgress,
} from "../../apps/web/src/investigator/InvestigationProgress";

const receipt = {
  investigationId: "review-1",
  incident: {
    incidentId: "incident-1",
    baselineReleaseId: "baseline-release",
    degradedReleaseId: "degraded-release",
    traceWindow: { sinceMs: 1_700_000_000_000, untilMs: 1_700_000_060_000 },
  },
  phases: [
    { toolName: "compare_releases", status: "complete" as const, attempts: [] },
    { toolName: "find_slow_traces", status: "complete" as const, attempts: [] },
    { toolName: "inspect_trace", status: "complete" as const, attempts: [] },
    { toolName: "inspect_release", status: "complete" as const, attempts: [] },
    { toolName: "read_repo_files", status: "pending" as const, attempts: [] },
  ],
  evidence: {
    baselineReleaseId: "baseline-release",
    degradedReleaseId: "degraded-release",
    selectedTraceId: "slow-trace-1",
    inspectedTraceId: "slow-trace-1",
    releaseId: "degraded-release",
    commitSha: "0123456789abcdef0123456789abcdef01234567",
    pullRequest: { status: "found" as const, number: 19 },
    sourceContent: "private source must never enter the progress log",
  },
};

describe("investigator progress", () => {
  it("turns persisted phases into chronological reasoning, tool-call, and result events", () => {
    const events = buildInvestigationEvents(receipt);

    expect(events.map((event) => event.kind)).toEqual([
      "reasoning",
      "tool-call",
      "tool-result",
      "reasoning",
      "tool-call",
      "tool-result",
      "reasoning",
      "tool-call",
      "tool-result",
      "reasoning",
      "tool-call",
      "tool-result",
      "reasoning",
      "tool-call",
    ]);
    expect(events[1]?.text).toContain("baseline-release");
    expect(events[4]?.text).toContain("1_700_000_000_000".replaceAll("_", ""));
    expect(events[5]?.text).toContain("slow-trace-1");
    expect(events[11]?.text).toContain("PR #19");
    expect(events[13]?.text).toContain("0123456789ab");
    expect(JSON.stringify(events)).not.toContain("private source");
  });

  it("renders normal chat events with collapsed reasoning summaries and visible tool traffic", () => {
    const markup = renderToStaticMarkup(<InvestigationProgress receipt={receipt} />);

    expect(markup).toContain('class="message assistant activity-message reasoning"');
    expect(markup).toContain("<details");
    expect(markup).not.toContain("<details open");
    expect(markup).toContain("Reasoning summary");
    expect(markup).toContain("Tool call · compare_releases");
    expect(markup).toContain("Tool result · compare_releases");
    expect(markup).toContain('aria-live="polite"');
    expect(markup).not.toContain("Investigator work log");
    expect(markup).not.toContain("<ol");
  });
});
