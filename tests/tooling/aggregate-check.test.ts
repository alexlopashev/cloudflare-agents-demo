import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("aggregate repository check", () => {
  it("runs every non-deployment CI gate once through the canonical check", () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const workflow = readFileSync(resolve(repositoryRoot, ".github/workflows/ci.yml"), "utf8");

    expect(packageJson.scripts.check).toBe(
      "pnpm doctor && pnpm container:check && pnpm format:check && pnpm lint && pnpm typecheck && pnpm test && pnpm e2e && pnpm build",
    );
    expect(packageJson.scripts["container:check"]).toBe(
      "docker-cli-plugin-docker-compose --file compose.yaml config --quiet",
    );
    expect(packageJson.scripts.e2e).not.toContain("test.mjs");
    expect(workflow.match(/mise run check/g)).toHaveLength(1);
    expect(workflow).not.toMatch(/mise run (?:doctor|container:check|e2e|build)/);
  });
});
