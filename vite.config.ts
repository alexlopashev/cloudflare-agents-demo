import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "apps/web",
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
