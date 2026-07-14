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

  it("uses only persisted evidence for credential-free previews and requires a token for writes", async () => {
    const repository = { owner: "alexlopashev", repo: "cloudflare-agents-demo" };
    const sourceBytes = new TextEncoder().encode(regressionHealthSource);
    const prefix = new TextEncoder().encode(`blob ${sourceBytes.byteLength}\0`);
    const input = new Uint8Array(prefix.byteLength + sourceBytes.byteLength);
    input.set(prefix);
    input.set(sourceBytes, prefix.byteLength);
    const expectedBlobSha = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-1", input)),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
    const proposal = { ...remediationFixture, expectedBlobSha };
    const sourceReleaseId = remediationFixture.incident.degradedReleaseId;
    const store = {
      getReleaseSourceEvidence: vi.fn(async () => ({
        releaseId: sourceReleaseId,
        commitSha: remediationFixture.expectedBaseSha,
        commitSubject: "perf: serialize health checks to limit pressure (#19)",
        committedAt: "2026-07-12T01:42:21.000Z",
        pullRequestNumber: 19,
        pullRequestHeadSha: "9af361e5a9420323b2c86f2670e3bf812ac58620",
        sourcePath: remediationFixture.path,
        blobSha: expectedBlobSha,
        byteLength: sourceBytes.byteLength,
        content: regressionHealthSource,
      })),
      getReleasePreviewEvidence: vi.fn(async () => ({
        releaseId: sourceReleaseId,
        baseSha: "a".repeat(40),
        sourcePath: remediationFixture.path,
        blobSha: expectedBlobSha,
        byteLength: sourceBytes.byteLength,
        content: regressionHealthSource,
      })),
    };
    const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry><id>tag:github.com,2008:Grit::Commit/${remediationFixture.expectedBaseSha}</id></entry>
</feed>`;
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "github.com" && url.pathname.endsWith("/commits/main.atom")) {
        return new Response(feed, { headers: { "content-type": "application/atom+xml" } });
      }
      if (url.hostname === "raw.githubusercontent.com") {
        return new Response(regressionHealthSource, { headers: { "content-type": "text/plain" } });
      }
      return new Response("not found", { status: 404 });
    });

    for (const token of [undefined, "", "   "]) {
      const preview = createAgentRemediationService({
        mode: "workers-ai",
        repository,
        writeEnabled: false,
        sourceReleaseId,
        previewBaseSha: "a".repeat(40),
        store,
        fetcher,
        ...(token === undefined ? {} : { token }),
      });
      await expect(preview.execute(proposal)).resolves.toMatchObject({
        status: "preview",
        writesPerformed: false,
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
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
