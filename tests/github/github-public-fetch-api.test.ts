import { describe, expect, it, vi } from "vitest";

import { GitHubPublicFetchApi } from "../../workers/platform/src/github/github-public-fetch-api";

const commitSha = "1111111111111111111111111111111111111111";
const patch = `From ${commitSha} Mon Sep 17 00:00:00 2001
From: Example Author <author@example.test>
Date: Sat, 11 Jul 2026 18:42:21 -0700
Subject: [PATCH] perf: serialize health checks (#42)

---
 apps/web/src/services.ts | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/apps/web/src/services.ts b/apps/web/src/services.ts
index 0000000..1111111 100644
--- a/apps/web/src/services.ts
+++ b/apps/web/src/services.ts
@@ -1 +1 @@
-fast
+slow
`;

describe("GitHubPublicFetchApi", () => {
  it("reads bounded immutable patch and raw-file evidence without REST or credentials", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "github.com") {
        return new Response(patch, { headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      if (url.hostname === "raw.githubusercontent.com") {
        return new Response("slow\n", { headers: { "content-type": "text/plain" } });
      }
      return new Response(null, { status: 404 });
    });
    const api = new GitHubPublicFetchApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 64_000,
    });

    await expect(api.getCommit(commitSha, 9)).resolves.toMatchObject({
      sha: commitSha,
      html_url: `https://github.com/example/supervised/commit/${commitSha}`,
      commit: {
        message: "perf: serialize health checks (#42)",
        committer: { date: "2026-07-12T01:42:21.000Z" },
      },
      author: null,
      files: [
        {
          filename: "apps/web/src/services.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ],
    });
    await expect(api.getPullRequestsForCommit(commitSha, 11)).resolves.toEqual([
      {
        source: "public-patch",
        number: 42,
        commitSubject: "perf: serialize health checks",
        html_url: "https://github.com/example/supervised/pull/42",
        head: { sha: commitSha },
      },
    ]);
    await expect(api.getFile(commitSha, "apps/web/src/services.ts")).resolves.toEqual({
      source: "public-raw",
      type: "file",
      path: "apps/web/src/services.ts",
      sha: "9737ef923d460158aa755d6144eb62681ada3c1b",
      size: 5,
      content: "slow\n",
    });
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls.every(([request]) => !request.headers.has("authorization"))).toBe(
      true,
    );
    expect(
      fetcher.mock.calls.some(([request]) => new URL(request.url).hostname === "api.github.com"),
    ).toBe(false);
  });

  it("fails closed on oversized, malformed, and unsafe public evidence", async () => {
    const oversized = new GitHubPublicFetchApi({
      fetcher: vi.fn(
        async () =>
          new Response("small", {
            headers: { "content-length": "101", "content-type": "text/plain" },
          }),
      ),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });
    await expect(oversized.getCommit(commitSha, 9)).rejects.toMatchObject({
      code: "limit-exceeded",
    });

    const malformed = new GitHubPublicFetchApi({
      fetcher: vi.fn(async () => new Response(patch.replaceAll("apps/web", "apps/../secrets"))),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 64_000,
    });
    await expect(malformed.getCommit(commitSha, 9)).rejects.toMatchObject({
      code: "malformed-response",
    });

    const fetcher = vi.fn(async () => new Response("must not run"));
    const pathGuard = new GitHubPublicFetchApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 64_000,
    });
    await expect(pathGuard.getFile(commitSha, "../secrets.txt")).rejects.toMatchObject({
      code: "not-allowed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
