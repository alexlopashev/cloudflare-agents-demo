import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  buildInvestigationUpdates,
  InvestigationProgress,
} from "../../apps/web/src/investigator/InvestigationProgress";

const receipt = {
  investigationId: "review-1",
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
  it("turns persisted evidence phases into concise, grounded chat updates", () => {
    const updates = buildInvestigationUpdates(receipt);

    expect(updates.map((update) => update.state)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
      "active",
    ]);
    expect(updates[0]?.text).toContain("baseline-release");
    expect(updates[1]?.text).toContain("slow-trace-1");
    expect(updates[3]?.text).toContain("PR #19");
    expect(updates[4]?.text).toMatch(/reading the allowlisted source/i);
    expect(JSON.stringify(updates)).not.toContain("private source");
  });

  it("renders the work log as an investigator chat update while evidence is gathered", () => {
    const markup = renderToStaticMarkup(<InvestigationProgress receipt={receipt} />);

    expect(markup).toContain('class="message assistant progress-message"');
    expect(markup).toContain('aria-live="polite"');
    expect(markup).toContain("Investigator work log");
    expect(markup).toContain("Reading the allowlisted source");
  });
});
