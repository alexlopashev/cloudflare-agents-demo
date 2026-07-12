import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/platform/src/index.ts",
      miniflare: {
        bindings: {
          GIT_SHA: "0000000000000000000000000000000000000000",
          GITHUB_OWNER: "alexlopashev",
          GITHUB_REPO: "cloudflare-agents-demo",
          HEALTH_LOADING_MODE: "sequential",
          MODEL_MODE: "fake",
          SCENARIO_CONTROL_ENABLED: "false",
        },
        compatibilityDate: "2026-07-11",
        compatibilityFlags: ["nodejs_compat"],
        d1Databases: ["TELEMETRY_DB"],
        durableObjects: {
          REGRESSION_SURGEON_AGENT: {
            className: "RegressionSurgeonAgent",
            useSQLite: true,
          },
        },
      },
    }),
  ],
  test: {
    include: ["tests/**/*.worker.test.ts"],
  },
});
