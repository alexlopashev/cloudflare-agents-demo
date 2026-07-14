import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "./agent/active-composition": new URL(
        "./workers/platform/src/demo/active-composition.ts",
        import.meta.url,
      ).pathname,
    },
  },
  root: "apps/web",
  server: { host: process.env.REGRESSION_SURGEON_DEV_HOST ?? "127.0.0.1" },
  plugins: [
    react(),
    cloudflare({
      configPath: "../../wrangler.jsonc",
      inspectorPort: false,
      persistState: { path: "../../.wrangler/state" },
      auxiliaryWorkers: [{ configPath: "../../workers/health-service/wrangler.jsonc" }],
    }),
  ],
});
