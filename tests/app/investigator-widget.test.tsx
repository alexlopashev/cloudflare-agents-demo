import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  buildInvestigatorChatOptions,
  canSubmitInvestigatorRequest,
  configuredInvestigationPrompt,
  InvestigationStarter,
  InvestigatorError,
  InvestigatorWidgetChrome,
  nextUnreadInvestigatorCount,
} from "../../apps/web/src/investigator/InvestigatorWidget";

describe("investigator support widget", () => {
  it("resumes the guarded tool turn only after the approval response is complete", () => {
    const chatOptions = buildInvestigatorChatOptions({ name: "investigator-agent" });
    const approvalPart = {
      type: "tool-create_draft_pr" as const,
      toolCallId: "tool-1",
      input: { proposalFingerprint: "proposal-v1-0123456789abcdef" },
      approval: { id: "approval-1" },
    };

    expect(
      chatOptions.sendAutomaticallyWhen({
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [{ ...approvalPart, state: "approval-requested" as const }],
          },
        ],
      }),
    ).toBe(false);
    expect(
      chatOptions.sendAutomaticallyWhen({
        messages: [
          {
            id: "assistant-1",
            role: "assistant",
            parts: [
              {
                ...approvalPart,
                state: "approval-responded" as const,
                approval: { id: "approval-1", approved: true },
              },
            ],
          },
        ],
      }),
    ).toBe(true);
  });

  it("allows an explicit retry after failure without overlapping an active turn", () => {
    expect(canSubmitInvestigatorRequest("ready")).toBe(true);
    expect(canSubmitInvestigatorRequest("error")).toBe(true);
    expect(canSubmitInvestigatorRequest("submitted")).toBe(false);
    expect(canSubmitInvestigatorRequest("streaming")).toBe(false);
  });

  it("counts only new investigator output received while collapsed", () => {
    expect(
      nextUnreadInvestigatorCount({
        isOpen: false,
        unreadCount: 0,
        previousAssistantMessageCount: 1,
        assistantMessageCount: 2,
      }),
    ).toBe(1);
    expect(
      nextUnreadInvestigatorCount({
        isOpen: false,
        unreadCount: 0,
        previousAssistantMessageCount: 2,
        assistantMessageCount: 2,
      }),
    ).toBe(0);
    expect(
      nextUnreadInvestigatorCount({
        isOpen: true,
        unreadCount: 4,
        previousAssistantMessageCount: 1,
        assistantMessageCount: 2,
      }),
    ).toBe(0);
  });

  it("shows a retry-safe public limit response without exposing unrelated errors", () => {
    const limited = renderToStaticMarkup(
      <InvestigatorError
        error={new Error("Public investigator limit reached. Retry in 60 seconds.")}
      />,
    );
    const privateFailure = renderToStaticMarkup(
      <InvestigatorError error={new Error("private provider exception and credential detail")} />,
    );

    expect(limited).toContain('role="alert"');
    expect(limited).toContain("Public investigator limit reached. Retry in 60 seconds.");
    expect(privateFailure).toContain("Investigator response failed. Retrying is safe.");
    expect(privateFailure).not.toContain("private provider exception");
  });

  it("collapses to an accessible floating launcher with only an unread badge", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorWidgetChrome
        isOpen={false}
        onClear={vi.fn()}
        onToggle={vi.fn()}
        status="ready"
        unreadCount={1}
      >
        <p>Persisted conversation</p>
      </InvestigatorWidgetChrome>,
    );

    expect(markup).toContain('class="support-launcher"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="investigator-dialog"');
    expect(markup).toContain('aria-label="1 unread investigator update"');
    expect(markup).not.toContain("availability-badge");
    expect(markup).not.toContain('aria-label="Investigator available"');
    expect(markup).toContain('id="investigator-dialog"');
    expect(markup).toContain("hidden");
    expect(markup).toContain("Persisted conversation");
  });

  it("shows no synthetic unread badge and offers one configured investigation action", () => {
    const chrome = renderToStaticMarkup(
      <InvestigatorWidgetChrome
        isOpen={false}
        onClear={vi.fn()}
        onToggle={vi.fn()}
        status="ready"
        unreadCount={0}
      >
        <p>No messages yet</p>
      </InvestigatorWidgetChrome>,
    );
    const starter = renderToStaticMarkup(
      <InvestigationStarter disabled={false} onInvestigate={vi.fn()} />,
    );

    expect(chrome).not.toContain("notification-badge");
    expect(chrome).not.toContain("availability-badge");
    expect(starter).toContain("Investigate the seeded latency regression");
    expect(starter).toContain('type="button"');
    expect(configuredInvestigationPrompt).toMatch(
      /investigate the seeded latency regression[\s\S]+prepare the guarded remediation preview/i,
    );
  });

  it("opens a named dialog with status and a collapse action", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorWidgetChrome
        isOpen
        onClear={vi.fn()}
        onToggle={vi.fn()}
        status="streaming"
        unreadCount={0}
      >
        <p>Active investigation</p>
      </InvestigatorWidgetChrome>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-labelledby="investigator-title"');
    expect(markup).toContain('aria-label="Collapse investigator"');
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>Clear chat<\/button>/);
    expect(markup).toContain("Investigating");
    expect(markup).toMatch(/<section[^>]*class="support-dialog panel"[^>]*>/);
    expect(markup).not.toMatch(/<section[^>]*class="support-dialog panel"[^>]*hidden/);
  });

  it("caps a large unread badge without losing its accessible count", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorWidgetChrome
        isOpen={false}
        onClear={vi.fn()}
        onToggle={vi.fn()}
        status="ready"
        unreadCount={14}
      >
        <p>Updates</p>
      </InvestigatorWidgetChrome>,
    );

    expect(markup).toContain(">9+</span>");
    expect(markup).toContain('aria-label="14 unread investigator updates"');
  });

  it("offers clear chat only when no investigator turn is active", () => {
    const ready = renderToStaticMarkup(
      <InvestigatorWidgetChrome
        isOpen
        onClear={vi.fn()}
        onToggle={vi.fn()}
        status="ready"
        unreadCount={0}
      >
        <p>Complete investigation</p>
      </InvestigatorWidgetChrome>,
    );
    const submitted = renderToStaticMarkup(
      <InvestigatorWidgetChrome
        isOpen
        onClear={vi.fn()}
        onToggle={vi.fn()}
        status="submitted"
        unreadCount={0}
      >
        <p>Active investigation</p>
      </InvestigatorWidgetChrome>,
    );

    expect(ready).toMatch(/<button[^>]*>Clear chat<\/button>/);
    expect(ready).not.toMatch(/<button[^>]*disabled=""[^>]*>Clear chat<\/button>/);
    expect(submitted).toMatch(/<button[^>]*disabled=""[^>]*>Clear chat<\/button>/);
  });
});
