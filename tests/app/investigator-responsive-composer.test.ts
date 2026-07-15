import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8");
const widgetSource = readFileSync(
  new URL("../../apps/web/src/investigator/InvestigatorWidget.tsx", import.meta.url),
  "utf8",
);
const styles = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");

describe("investigator mobile composer", () => {
  it("provides an explicit responsive control group and a usable mobile send target", () => {
    expect(widgetSource).toContain('className="composer-controls"');
    expect(appSource).toContain("<Deployboard />");
    expect(appSource).toContain("<InvestigatorWidget");
    expect(widgetSource).toContain('className="support-launcher"');
    expect(widgetSource).toContain('role="dialog"');
    expect(styles).toMatch(/\.composer-controls\s*{[^}]*display:\s*flex;/s);
    expect(styles).toMatch(/\.composer button\s*{[^}]*min-height:\s*44px;/s);
    expect(styles).toMatch(/\.support-dialog\s*{[^}]*position:\s*absolute;/s);
    expect(styles).toMatch(/\.support-launcher\s*{[^}]*min-width:\s*56px;/s);

    const mobileStyles = styles.match(/@media \(max-width: 760px\)\s*{([\s\S]*)}\s*$/)?.[1] ?? "";
    expect(mobileStyles).toMatch(
      /\.composer-controls\s*{[^}]*(flex-direction:\s*column|display:\s*grid)/s,
    );
    expect(mobileStyles).toMatch(/\.composer button\s*{[^}]*width:\s*100%;/s);
    expect(mobileStyles).toMatch(/\.support-dialog\s*{[^}]*position:\s*fixed;[^}]*inset:\s*0;/s);
    expect(mobileStyles).toMatch(/\.support-dialog\s*{[^}]*width:\s*100%;[^}]*height:\s*100dvh;/s);
  });

  it("reserves review space while keeping the investigator chat visible", () => {
    expect(styles).toMatch(
      /\.chat-panel:has\(\.approval-panel\) \.approval-panel\s*{[^}]*min-height:\s*220px;/s,
    );
    expect(styles).not.toMatch(
      /\.chat-panel:has\(\.approval-panel\) \.messages\s*{[^}]*display:\s*none;/s,
    );
    expect(widgetSource).not.toContain("ToolTimeline");
    expect(styles).not.toContain(".tool-timeline");
    expect(widgetSource.indexOf("<ApprovalPanel")).toBeGreaterThan(
      widgetSource.indexOf('className="messages"'),
    );
  });
});
