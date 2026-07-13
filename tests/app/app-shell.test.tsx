import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SiteHeader } from "../../apps/web/src/App";

describe("application header", () => {
  it("keeps the product brand without redundant experience pills", () => {
    const markup = renderToStaticMarkup(<SiteHeader />);

    expect(markup).toContain('class="brand"');
    expect(markup).toContain('href="/app"');
    expect(markup).toContain("Regression Surgeon");
    expect(markup).not.toContain("Product experiences");
    expect(markup).not.toContain("Deployboard");
    expect(markup).not.toContain("Investigator");
  });
});
