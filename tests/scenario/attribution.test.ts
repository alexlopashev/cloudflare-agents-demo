import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { regressionSource } from "../../packages/test-fixtures/src/scenario";

describe("scenario source attribution", () => {
  it("pins the degraded release to the merged regression PR instead of the current checkout", async () => {
    expect(regressionSource).toEqual({
      commitSha: "d591869a8ef995f1835ef80152f4de085b10255b",
      pullRequestNumber: 19,
    });

    const script = await readFile(new URL("../../scripts/scenario.mjs", import.meta.url), "utf8");
    expect(script).not.toContain('execFileSync("git", ["rev-parse", "HEAD"]');
    expect(script).toContain("regressionSource.commitSha");
  });
});
