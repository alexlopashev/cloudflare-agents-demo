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
  test: {
    include: ["tests/**/*.test.{ts,tsx}"],
    exclude: ["tests/**/*.worker.test.ts"],
  },
});
