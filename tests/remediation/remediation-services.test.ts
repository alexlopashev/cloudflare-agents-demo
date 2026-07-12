import { describe, expect, it, vi } from "vitest";

import { remediationFixture } from "../../packages/test-fixtures/src/remediation";
import { createAgentRemediationService } from "../../workers/platform/src/agent/remediation-services";

describe("agent remediation services", () => {
  it("returns a deterministic validated preview in fake mode without network or writes", async () => {
    const fetcher = vi.fn(async () => new Response("network must not be used"));
    const service = createAgentRemediationService({
      mode: "fake",
      repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
      writeEnabled: true,
      fetcher,
    });

    await expect(service.execute(remediationFixture)).resolves.toMatchObject({
      status: "preview",
      writesPerformed: false,
      file: { path: "workers/platform/src/api/health.ts" },
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("requires an explicit supported mode and a token for the live write adapter", () => {
    const repository = { owner: "alexlopashev", repo: "cloudflare-agents-demo" };

    expect(() =>
      createAgentRemediationService({ mode: "workers-ai", repository, writeEnabled: false }),
    ).toThrow();
    expect(() =>
      createAgentRemediationService({ mode: "unsupported", repository, writeEnabled: false }),
    ).toThrow("Unsupported remediation mode");
  });
});
