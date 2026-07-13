import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { InvestigatorMessage } from "../../apps/web/src/investigator/InvestigatorMessage";

describe("investigator message rendering", () => {
  it("renders assistant reports as semantic GitHub-flavored Markdown", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorMessage
        messageRole="assistant"
        text={[
          "## Evidence",
          "",
          "- Release `bad-123` is slower.",
          "- [Inspect the pull request](https://github.com/example/repo/pull/19).",
          "",
          "| Metric | Value |",
          "| --- | ---: |",
          "| p75 | 538 ms |",
        ].join("\n")}
      />,
    );

    expect(markup).toContain("<h2>Evidence</h2>");
    expect(markup).toContain("<ul>");
    expect(markup).toContain("<code>bad-123</code>");
    expect(markup).toContain('href="https://github.com/example/repo/pull/19"');
    expect(markup).toContain("<table>");
  });

  it("does not turn raw generated HTML into DOM elements", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorMessage
        messageRole="assistant"
        text={'Evidence <script>alert("unsafe")</script> <strong>untrusted</strong>'}
      />,
    );

    expect(markup).not.toContain("<script");
    expect(markup).not.toContain("<strong>");
  });

  it("keeps user requests literal", () => {
    const markup = renderToStaticMarkup(
      <InvestigatorMessage messageRole="user" text={'**do not emphasize** <img src="x">'} />,
    );

    expect(markup).toContain("**do not emphasize**");
    expect(markup).not.toContain("<strong>");
    expect(markup).not.toContain("<img");
  });
});
