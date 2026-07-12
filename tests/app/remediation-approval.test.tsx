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
          title: "fix: bound health-check concurrency",
          path: "workers/platform/src/api/health.ts",
          replacementContent: "private full source must not render",
          incident: { traceId: "scenario-trace-34" },
        },
      },
    ],
  },
];

describe("remediation approval panel", () => {
  it("projects only bounded human-readable approval details", () => {
    expect(buildApprovalRequests(messages)).toEqual([
      {
        approvalId: "approval-1",
        toolCallId: "tool-1",
        title: "fix: bound health-check concurrency",
        path: "workers/platform/src/api/health.ts",
        traceId: "scenario-trace-34",
      },
    ]);
    expect(JSON.stringify(buildApprovalRequests(messages))).not.toContain("private full source");
  });

  it("renders explicit approve and reject controls for the guarded draft PR", () => {
    const markup = renderToStaticMarkup(
      <ApprovalPanel requests={buildApprovalRequests(messages)} onDecision={vi.fn()} />,
    );

    expect(markup).toContain('aria-label="Draft pull request approval"');
    expect(markup).toContain("scenario-trace-34");
    expect(markup).toContain("workers/platform/src/api/health.ts");
    expect(markup).toContain("Approve draft PR");
    expect(markup).toContain("Reject");
  });
});
