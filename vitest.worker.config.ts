import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./workers/platform/src/index.ts",
      miniflare: {
        bindings: { MODEL_MODE: "fake" },
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
    include: ["tests/platform/**/*.worker.test.ts"],
  },
});
