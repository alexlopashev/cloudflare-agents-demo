import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ApprovalPanel,
  buildApprovalOutcome,
  buildApprovalRequests,
  buildCompactDiff,
  startApprovalDecision,
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
  writeEnabled: true,
  proposal: {
    title: "fix: bound health-check concurrency",
    path: "workers/platform/src/api/health.ts",
    replacementContent: "before context\nprivate full source must not render\nafter context",
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
    currentContent: "before context\ncurrent bounded source\nafter context",
    replacementContent: "before context\nprivate full source must not render\nafter context",
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
        currentContent: "before context\ncurrent bounded source\nafter context",
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
        replacementContent: "before context\nprivate full source must not render\nafter context",
        writePosture: "Live draft-PR writes enabled",
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
    expect(markup).toContain("Live draft-PR writes enabled");
    expect(markup).toContain("Review exact change");
    expect(markup).toMatch(/<details(?![^>]*open)/);
    expect(markup.match(/<pre/g)).toHaveLength(1);
    expect(markup).toContain("-current bounded source");
    expect(markup).toContain("+private full source must not render");
    expect(markup).toContain("Create Draft PR");
    expect(markup).not.toContain("Approve draft PR");
    expect(markup).toContain("Reject");
  });

  it("dispatches one decision only after showing immediate guarded-action feedback", async () => {
    const request = buildApprovalRequests(messages, preparedRemediation)[0];
    if (request === undefined) throw new Error("Expected approval request fixture.");
    const events: string[] = [];

    await startApprovalDecision({
      approved: true,
      dispatch: ({ id, approved }) => events.push(`dispatch:${id}:${approved}`),
      request,
      update: (decision) => events.push(`ui:${decision.state}:${decision.approved}`),
    });

    expect(events).toEqual(["ui:submitting:true", "dispatch:approval-1:true"]);
  });

  it("shows a retryable failure when asynchronous approval submission is rejected", async () => {
    const request = buildApprovalRequests(messages, preparedRemediation)[0];
    if (request === undefined) throw new Error("Expected approval request fixture.");
    const states: string[] = [];

    await startApprovalDecision({
      approved: true,
      dispatch: async () => {
        throw new Error("connection closed");
      },
      request,
      update: (decision) => states.push(decision.state),
    });

    expect(states).toEqual(["submitting", "failed"]);
  });

  it("projects rejected, preview, and created outcomes without fabricating writes", () => {
    const request = buildApprovalRequests(messages, preparedRemediation)[0];
    if (request === undefined) throw new Error("Expected approval request fixture.");
    const decision = { approved: false, request, state: "submitting" as const };

    expect(buildApprovalOutcome(messages, decision)).toMatchObject({ state: "rejected" });
    expect(
      buildApprovalOutcome([
        {
          id: "assistant-1",
          parts: [
            {
              type: "tool-create_draft_pr",
              state: "output-available",
              toolCallId: "tool-1",
              output: { status: "preview", writesPerformed: false },
            },
          ],
        },
      ]),
    ).toEqual({
      message: "Preview complete. No GitHub write was performed.",
      state: "preview",
    });
    expect(
      buildApprovalOutcome([
        {
          id: "assistant-1",
          parts: [
            {
              type: "tool-create_draft_pr",
              state: "output-available",
              toolCallId: "tool-1",
              output: {
                status: "created",
                writesPerformed: true,
                repository: "alexlopashev/cloudflare-agents-demo",
                number: 127,
                url: "https://github.com/alexlopashev/cloudflare-agents-demo/pull/127",
                draft: true,
              },
            },
          ],
        },
      ]),
    ).toEqual({
      message: "Draft PR #127 created.",
      number: 127,
      state: "created",
      url: "https://github.com/alexlopashev/cloudflare-agents-demo/pull/127",
    });
  });

  it("shows only the bounded GitHub operation failure returned by the guarded action", () => {
    const safeMessage =
      "GitHub create-draft-pr failed with HTTP 403. No draft PR was confirmed. Retry requires a new approval.";
    expect(
      buildApprovalOutcome([
        {
          id: "assistant-1",
          parts: [
            {
              type: "tool-create_draft_pr",
              state: "output-available",
              toolCallId: "tool-1",
              output: { error: { name: "Error", message: safeMessage } },
            },
          ],
        },
      ]),
    ).toEqual({ message: safeMessage, state: "failed" });

    expect(
      buildApprovalOutcome([
        {
          id: "assistant-1",
          parts: [
            {
              type: "tool-create_draft_pr",
              state: "output-available",
              toolCallId: "tool-1",
              output: { error: { message: "token=must-not-render" } },
            },
          ],
        },
      ]),
    ).toEqual({ message: "Draft PR action stopped safely. Retrying is safe.", state: "failed" });
  });

  it("renders a terminal action result without stale approval controls", () => {
    const markup = renderToStaticMarkup(
      <ApprovalPanel
        requests={[]}
        outcome={{
          message: "Preview complete. No GitHub write was performed.",
          state: "preview",
        }}
        onDecision={vi.fn()}
      />,
    );

    expect(markup).toContain("Draft PR action");
    expect(markup).not.toContain("Human approval required");
    expect(markup).not.toContain("<button");
  });

  it("builds one bounded unified diff instead of two full-source columns", () => {
    expect(buildCompactDiff("alpha\nbeta\ngamma", "alpha\nbounded\ngamma")).toBe(
      "@@ -1,3 +1,3 @@\n alpha\n-beta\n+bounded\n gamma",
    );
  });
});
