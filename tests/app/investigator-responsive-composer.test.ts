import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const appSource = readFileSync(new URL("../../apps/web/src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../../apps/web/src/styles.css", import.meta.url), "utf8");

describe("investigator mobile composer", () => {
  it("provides an explicit responsive control group and a usable mobile send target", () => {
    expect(appSource).toContain('className="composer-controls"');
    expect(styles).toMatch(/\.composer-controls\s*{[^}]*display:\s*flex;/s);
    expect(styles).toMatch(/\.composer button\s*{[^}]*min-height:\s*44px;/s);

    const mobileStyles = styles.match(/@media \(max-width: 760px\)\s*{([\s\S]*)}\s*$/)?.[1] ?? "";
    expect(mobileStyles).toMatch(
      /\.composer-controls\s*{[^}]*(flex-direction:\s*column|display:\s*grid)/s,
    );
    expect(mobileStyles).toMatch(/\.composer button\s*{[^}]*width:\s*100%;/s);
  });
});
