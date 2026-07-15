import { describe, expect, it, vi } from "vitest";

import { GitHubPublicPreviewApi } from "../../workers/platform/src/github/github-public-preview-api";

const commitSha = "1111111111111111111111111111111111111111";
const feed = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <entry>
    <id>tag:github.com,2008:Grit::Commit/${commitSha}</id>
  </entry>
</feed>`;

describe("GitHubPublicPreviewApi", () => {
  it("validates preview freshness through a bounded branch feed and immutable raw file", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "github.com") return new Response(feed);
      if (url.hostname === "raw.githubusercontent.com") return new Response("source\n");
      return new Response(null, { status: 404 });
    });
    const api = new GitHubPublicPreviewApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      allowedPaths: ["workers/platform/src/api/health.ts"],
      maxResponseBytes: 64_000,
    });

    await expect(api.getBase("main")).resolves.toEqual({ sha: commitSha });
    await expect(api.getFile(commitSha, "workers/platform/src/api/health.ts")).resolves.toEqual({
      blobSha: "5a18cd2fbf65e961b0fd3f6cd6b0b6160f2c808e",
      content: "source\n",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.every(([request]) => !request.headers.has("authorization"))).toBe(
      true,
    );
    expect(
      fetcher.mock.calls.some(([request]) => new URL(request.url).hostname === "api.github.com"),
    ).toBe(false);
  });

  it("fails closed on a different branch and path without exposing write capabilities", async () => {
    const fetcher = vi.fn(
      async () => new Response("<feed><entry><id>not-a-sha</id></entry></feed>"),
    );
    const api = new GitHubPublicPreviewApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      allowedPaths: ["workers/platform/src/api/health.ts"],
      maxResponseBytes: 64_000,
    });

    await expect(api.getBase("release")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(api.getBase("main")).rejects.toMatchObject({ code: "malformed-response" });
    await expect(api.getFile(commitSha, "README.md")).rejects.toMatchObject({
      code: "not-allowed",
    });
    expect("createBlob" in api).toBe(false);
    expect("createTree" in api).toBe(false);
    expect("createCommit" in api).toBe(false);
    expect("createBranch" in api).toBe(false);
    expect("createDraftPullRequest" in api).toBe(false);
  });
});
