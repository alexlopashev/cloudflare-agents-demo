import { describe, expect, it } from "vitest";

import { isKnownIncompleteDependencySourcemap } from "../../scripts/run-worker-tests.ts";

describe("Worker test output policy", () => {
  it("recognizes only incomplete maps from audited transitive packages", () => {
    expect(
      isKnownIncompleteDependencySourcemap(
        'Sourcemap for "/repo/node_modules/.pnpm/@workflow+serde@4.1.0-beta.2/node_modules/@workflow/serde/dist/index.js" points to missing source files',
      ),
    ).toBe(true);
    expect(
      isKnownIncompleteDependencySourcemap(
        'Sourcemap for "/repo/node_modules/.pnpm/@modelcontextprotocol+sdk@1.29.0_peer/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js" points to missing source files',
      ),
    ).toBe(true);
    expect(
      isKnownIncompleteDependencySourcemap(
        'Sourcemap for "/repo/node_modules/.pnpm/cron-schedule@6.0.0/node_modules/cron-schedule/dist/index.js" points to missing source files',
      ),
    ).toBe(true);
    expect(
      isKnownIncompleteDependencySourcemap(
        'Sourcemap for "/repo/workers/platform/src/index.ts" points to missing source files',
      ),
    ).toBe(false);
    expect(isKnownIncompleteDependencySourcemap("A different warning")).toBe(false);
  });
});
