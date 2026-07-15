import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ApprovalPanel,
  buildApprovalRequests,
} from "../../apps/web/src/investigator/ApprovalPanel";

const messages = [
  {
    id: "assistant-1",
    parts: [
      {
        type: "tool-create_draft_pr",
        state: "approval-requested",
        toolCallId: "tool-1",
        approval: { id: "approval-1" },
        input: {
          proposalFingerprint: "proposal-v1-0123456789abcdef",
        },
      },
    ],
  },
];

const preparedRemediation = {
  fingerprint: "proposal-v1-0123456789abcdef",
  writeEnabled: false,
  proposal: {
    title: "fix: bound health-check concurrency",
    path: "workers/platform/src/api/health.ts",
    replacementContent: "private full source must not render",
    rationale: "Preserve downstream capacity with bounded concurrency.",
    expectedBlobSha: "3333333333333333333333333333333333333333",
    incident: {
      traceId: "scenario-trace-34",
      regressionCommitSha: "0123456789abcdef0123456789abcdef01234567",
      sourcePullRequestNumber: 19,
    },
  },
  diff: {
    path: "workers/platform/src/api/health.ts",
    currentContent: "current bounded source",
    replacementContent: "private full source must not render",
    additions: 4,
    deletions: 3,
  },
};

describe("remediation approval panel", () => {
  it("projects only bounded human-readable approval details", () => {
    expect(buildApprovalRequests(messages, preparedRemediation)).toEqual([
      {
        additions: 4,
        approvalId: "approval-1",
        changedLineCount: 7,
        currentContent: "current bounded source",
        deletions: 3,
        expectedBlobSha: "3333333333333333333333333333333333333333",
        fileCount: 1,
        toolCallId: "tool-1",
        title: "fix: bound health-check concurrency",
        path: "workers/platform/src/api/health.ts",
        traceId: "scenario-trace-34",
        regressionCommitSha: "0123456789abcdef0123456789abcdef01234567",
        sourcePullRequestNumber: 19,
        proposalFingerprint: "proposal-v1-0123456789abcdef",
        rationale: "Preserve downstream capacity with bounded concurrency.",
        replacementContent: "private full source must not render",
        writePosture: "Preview only — external GitHub writes disabled",
      },
    ]);
    expect(JSON.stringify(buildApprovalRequests(messages, preparedRemediation))).toContain(
      "private full source",
    );
  });

  it("renders explicit approve and reject controls for the guarded draft PR", () => {
    const markup = renderToStaticMarkup(
      <ApprovalPanel
        requests={buildApprovalRequests(messages, preparedRemediation)}
        onDecision={vi.fn()}
      />,
    );

    expect(markup).toContain('aria-label="Draft pull request approval"');
    expect(markup).toContain("scenario-trace-34");
    expect(markup).toContain("workers/platform/src/api/health.ts");
    expect(markup).toContain("proposal-v1-0123456789abcdef");
    expect(markup).toContain("Preserve downstream capacity with bounded concurrency.");
    expect(markup).toContain("1 file");
    expect(markup).toContain("7 changed lines");
    expect(markup).toContain("4 additions");
    expect(markup).toContain("3 deletions");
    expect(markup).toContain("0123456789abcdef0123456789abcdef01234567");
    expect(markup).toContain("PR #19");
    expect(markup).toContain("3333333333333333333333333333333333333333");
    expect(markup).toContain("Preview only — external GitHub writes disabled");
    expect(markup).toContain("current bounded source");
    expect(markup).toContain("private full source must not render");
    expect(markup).toContain("Approve draft PR");
    expect(markup).toContain("Reject");
  });
});
