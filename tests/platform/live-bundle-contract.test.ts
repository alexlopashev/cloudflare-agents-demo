import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assertLiveBundle } from "../../scripts/assert-live-bundle";

const repositoryRoot = resolve(import.meta.dirname, "../..");
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("live production bundle contract", () => {
  it("keeps the active Worker composition production-only and scans its dry-run bundle", () => {
    const activeComposition = readFileSync(
      resolve(repositoryRoot, "workers/platform/src/agent/active-composition.ts"),
      "utf8",
    );
    const viteConfig = readFileSync(resolve(repositoryRoot, "vite.config.ts"), "utf8");
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(activeComposition).toContain("liveAgentComposition");
    expect(activeComposition).not.toContain("demoAgentComposition");
    expect(viteConfig).toContain("demo/active-composition.ts");
    expect(packageJson.scripts?.build).toContain("wrangler deploy --dry-run");
    expect(packageJson.scripts?.build).toContain("node scripts/assert-live-bundle.ts");
  });

  it("rejects deterministic model, fixture, and test-provider markers", () => {
    const directory = mkdtempSync(join(tmpdir(), "regression-surgeon-live-bundle-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "index.js"), "new MockLanguageModelV3()", "utf8");

    expect(() => assertLiveBundle(directory)).toThrow(/MockLanguageModelV3/);
  });

  it("accepts a production-only bundle", () => {
    const directory = mkdtempSync(join(tmpdir(), "regression-surgeon-live-bundle-"));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, "index.js"), "export default { fetch() {} }", "utf8");

    expect(() => assertLiveBundle(directory)).not.toThrow();
  });
});
