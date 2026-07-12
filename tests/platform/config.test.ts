import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(import.meta.dirname, "../..");

function readJson(path: string) {
  return JSON.parse(readFileSync(resolve(repositoryRoot, path), "utf8")) as Record<string, unknown>;
}

function readText(path: string) {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

describe("Cloudflare configuration", () => {
  it.each([
    "wrangler.jsonc",
    "wrangler.live.jsonc",
    "workers/health-service/wrangler.jsonc",
  ])("%s pins the agreed runtime contract", (path) => {
    const config = readJson(path);

    expect(config.compatibility_date).toBe("2026-07-11");
    expect(config.compatibility_flags).toEqual(["nodejs_compat"]);
  });

  it("declares every platform binding and the SQLite Think migration", () => {
    const config = readJson("wrangler.jsonc");

    expect(config.ai).toBeUndefined();
    expect(config.version_metadata).toEqual({ binding: "CF_VERSION_METADATA" });
    expect(config.durable_objects).toEqual({
      bindings: [{ class_name: "RegressionSurgeonAgent", name: "REGRESSION_SURGEON_AGENT" }],
    });
    expect(config.migrations).toEqual([
      { new_sqlite_classes: ["RegressionSurgeonAgent"], tag: "v1" },
    ]);
    expect(config.d1_databases).toEqual([
      expect.objectContaining({ binding: "TELEMETRY_DB", migrations_dir: "migrations/telemetry" }),
    ]);
    expect(config.services).toEqual([
      {
        binding: "HEALTH_SERVICE",
        service: "regression-surgeon-health-service",
      },
    ]);
    expect(config.vars).toEqual({
      GIT_SHA: "0000000000000000000000000000000000000000",
      MODEL_MODE: "fake",
    });
  });

  it("isolates the remote Workers AI binding in the explicit live environment", () => {
    const config = readJson("wrangler.live.jsonc");

    expect(config.ai).toEqual({ binding: "AI" });
    expect(config.vars).toEqual({
      GIT_SHA: "0000000000000000000000000000000000000000",
      MODEL_MODE: "workers-ai",
    });
  });

  it("shares one local persistence directory and applies D1 migrations before serving", () => {
    expect(readText("vite.config.ts")).toContain('persistState: { path: "../../.wrangler/state" }');
    const packageJson = readJson("package.json") as {
      scripts?: Record<string, string>;
    };
    expect(packageJson.scripts?.["db:migrate:local"]).toBe(
      "CI=1 wrangler d1 migrations apply regression-surgeon-telemetry --local --config wrangler.jsonc",
    );
    expect(packageJson.scripts?.dev).toBe("pnpm db:migrate:local && vite dev");
    expect(packageJson.scripts?.e2e).toContain("pnpm db:migrate:local");
    expect(readText("mise.toml")).toContain('[tasks."db:migrate"]');
  });
});
