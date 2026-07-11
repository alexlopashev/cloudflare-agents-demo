import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/platform/**/*.test.ts"],
    exclude: ["tests/platform/**/*.worker.test.ts"],
  },
});
