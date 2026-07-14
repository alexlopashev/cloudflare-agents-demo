import { describe, expect, it, vi } from "vitest";

import {
  regressionHealthSource,
  remediationFixture,
} from "../../packages/test-fixtures/src/remediation";
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

  it("allows credential-free Workers AI previews but requires a token before enabling writes", async () => {
    const repository = { owner: "alexlopashev", repo: "cloudflare-agents-demo" };
    const treeSha = "1111111111111111111111111111111111111111";
    const encodedSource = btoa(regressionHealthSource);
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { sha: remediationFixture.expectedBaseSha } });
      }
      if (url.pathname.endsWith(`/git/commits/${remediationFixture.expectedBaseSha}`)) {
        return Response.json({ sha: remediationFixture.expectedBaseSha, tree: { sha: treeSha } });
      }
      if (url.pathname.endsWith("/contents/workers/platform/src/api/health.ts")) {
        return Response.json({
          type: "file",
          path: remediationFixture.path,
          sha: remediationFixture.expectedBlobSha,
          size: new TextEncoder().encode(regressionHealthSource).byteLength,
          encoding: "base64",
          content: encodedSource,
        });
      }
      return new Response("not found", { status: 404 });
    });

    for (const token of [undefined, "", "   "]) {
      const preview = createAgentRemediationService({
        mode: "workers-ai",
        repository,
        writeEnabled: false,
        fetcher,
        ...(token === undefined ? {} : { token }),
      });
      await expect(preview.execute(remediationFixture)).resolves.toMatchObject({
        status: "preview",
        writesPerformed: false,
      });
    }
    expect(fetcher).toHaveBeenCalledTimes(9);
    expect(fetcher.mock.calls.every(([request]) => !request.headers.has("authorization"))).toBe(
      true,
    );
    for (const token of [undefined, "", "   "]) {
      expect(() =>
        createAgentRemediationService({
          mode: "workers-ai",
          repository,
          writeEnabled: true,
          ...(token === undefined ? {} : { token }),
        }),
      ).toThrow(/non-empty scoped token/i);
    }
    expect(() =>
      createAgentRemediationService({ mode: "unsupported", repository, writeEnabled: false }),
    ).toThrow("Unsupported remediation mode");
  });
});
