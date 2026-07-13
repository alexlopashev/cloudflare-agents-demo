import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  canSubmitInvestigatorRequest,
  InvestigationStarter,
  InvestigatorWidgetChrome,
} from "../../apps/web/src/investigator/InvestigatorWidget";

describe("investigator support widget", () => {
  it("allows an explicit retry after failure without overlapping an active turn", () => {
    expect(canSubmitInvestigatorRequest("ready")).toBe(true);
    expect(canSubmitInvestigatorRequest("error")).toBe(true);
    expect(canSubmitInvestigatorRequest("submitted")).toBe(false);
    expect(canSubmitInvestigatorRequest("streaming")).toBe(false);
  });

  it("collapses to an accessible floating launcher with attention and availability badges", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorWidgetChrome isOpen={false} onToggle={vi.fn()} status="ready" unreadCount={1}>
        <p>Persisted conversation</p>
      </InvestigatorWidgetChrome>,
    );

    expect(markup).toContain('class="support-launcher"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="investigator-dialog"');
    expect(markup).toContain('aria-label="1 unread investigator update"');
    expect(markup).toContain('aria-label="Investigator available"');
    expect(markup).toContain('id="investigator-dialog"');
    expect(markup).toContain("hidden");
    expect(markup).toContain("Persisted conversation");
  });

  it("shows no synthetic unread badge and offers one configured investigation action", () => {
    const chrome = renderToStaticMarkup(
      <InvestigatorWidgetChrome isOpen={false} onToggle={vi.fn()} status="ready" unreadCount={0}>
        <p>No messages yet</p>
      </InvestigatorWidgetChrome>,
    );
    const starter = renderToStaticMarkup(
      <InvestigationStarter disabled={false} onInvestigate={vi.fn()} />,
    );

    expect(chrome).not.toContain("notification-badge");
    expect(starter).toContain("Investigate the seeded latency regression");
    expect(starter).toContain('type="button"');
  });

  it("opens a named dialog with status and a collapse action", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorWidgetChrome isOpen onToggle={vi.fn()} status="streaming" unreadCount={0}>
        <p>Active investigation</p>
      </InvestigatorWidgetChrome>,
    );

    expect(markup).toContain('aria-expanded="true"');
    expect(markup).toContain('role="dialog"');
    expect(markup).toContain('aria-labelledby="investigator-title"');
    expect(markup).toContain('aria-label="Collapse investigator"');
    expect(markup).toContain("Investigating");
    expect(markup).toMatch(/<section[^>]*class="support-dialog panel"[^>]*>/);
    expect(markup).not.toMatch(/<section[^>]*class="support-dialog panel"[^>]*hidden/);
  });

  it("caps a large unread badge without losing its accessible count", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorWidgetChrome isOpen={false} onToggle={vi.fn()} status="ready" unreadCount={14}>
        <p>Updates</p>
      </InvestigatorWidgetChrome>,
    );

    expect(markup).toContain(">9+</span>");
    expect(markup).toContain('aria-label="14 unread investigator updates"');
  });
});
