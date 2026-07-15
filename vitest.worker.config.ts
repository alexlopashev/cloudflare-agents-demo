import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "./agent/active-composition": new URL(
        "./workers/platform/src/demo/active-composition.ts",
        import.meta.url,
      ).pathname,
    },
  },
  plugins: [
    cloudflareTest({
      main: "./workers/platform/src/index.ts",
      miniflare: {
        bindings: {
          DEPLOY_SMOKE_KEY: "",
          EVIDENCE_INCIDENT_ID: "configured-latency-regression",
          EVIDENCE_BASELINE_RELEASE_ID: "baseline-concurrent",
          EVIDENCE_DEGRADED_RELEASE_ID: "regression-sequential",
          EVIDENCE_DEGRADED_SINCE_MS: "1700086400000",
          EVIDENCE_DEGRADED_UNTIL_MS: "1700086460000",
          GIT_SHA: "0000000000000000000000000000000000000000",
          GITHUB_OWNER: "alexlopashev",
          GITHUB_REPO: "cloudflare-agents-demo",
          GITHUB_WRITE_ENABLED: "false",
          HEALTH_LOADING_MODE: "sequential",
          MODEL_MODE: "fake",
          PUBLIC_USAGE_MODE: "local",
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
    name: "worker",
    include: ["tests/**/*.worker.test.ts"],
  },
});
