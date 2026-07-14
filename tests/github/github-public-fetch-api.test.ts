import { describe, expect, it, vi } from "vitest";

import { GitHubPublicFetchApi } from "../../workers/platform/src/github/github-public-fetch-api";

const regressionSha = "1111111111111111111111111111111111111111";
const pullRequestHeadSha = "2222222222222222222222222222222222222222";
const sourcePath = "workers/platform/src/api/health.ts";

function pullRequestPatch(
  options: { headSha?: string; path?: string; secondCommit?: boolean } = {},
) {
  const headSha = options.headSha ?? pullRequestHeadSha;
  const path = options.path ?? sourcePath;
  const first = `From ${headSha} Mon Sep 17 00:00:00 2001
From: Example Author <author@example.test>
Date: Sat, 11 Jul 2026 18:42:21 -0700
Subject: [PATCH] perf: serialize health checks

---
 ${path} | 2 +-
 1 file changed, 1 insertion(+), 1 deletion(-)

diff --git a/${path} b/${path}
index 0000000..1111111 100644
--- a/${path}
+++ b/${path}
@@ -1 +1 @@
-concurrent
+sequential
`;
  if (options.secondCommit !== true) return first;
  return `${first}
From 3333333333333333333333333333333333333333 Mon Sep 17 00:00:00 2001
From: Example Author <author@example.test>
Date: Sat, 11 Jul 2026 18:43:21 -0700
Subject: [PATCH 2/2] another change

---
 ${path} | 1 +
 1 file changed, 1 insertion(+)

diff --git a/${path} b/${path}
index 1111111..2222222 100644
--- a/${path}
+++ b/${path}
@@ -1 +1,2 @@
 sequential
+extra
`;
}

function api(fetcher: (request: Request) => Promise<Response>, maxResponseBytes = 64_000) {
  return new GitHubPublicFetchApi({
    fetcher,
    repository: { owner: "example", repo: "supervised" },
    maxResponseBytes,
    provenance: {
      pullRequestNumber: 19,
      pullRequestHeadSha,
      sourcePath,
    },
  });
}

describe("GitHubPublicFetchApi", () => {
  it("proves a configured PR through exact immutable source equality without REST or credentials", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "patch-diff.githubusercontent.com") {
        return new Response(pullRequestPatch(), {
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }
      if (url.hostname === "raw.githubusercontent.com") {
        return new Response("sequential\n", { headers: { "content-type": "text/plain" } });
      }
      return new Response(null, { status: 404 });
    });
    const publicApi = api(fetcher);

    await expect(publicApi.getCommit(regressionSha, 9)).resolves.toEqual({
      source: "configured-pr-provenance",
      sha: regressionSha,
      html_url: `https://github.com/example/supervised/commit/${regressionSha}`,
      metadata: {
        status: "partial",
        unknowns: ["message", "committed-at", "author-login"],
      },
      files: [
        {
          filename: sourcePath,
          status: "modified",
          additions: 1,
          deletions: 1,
        },
      ],
    });
    await expect(publicApi.getPullRequestsForCommit(regressionSha, 11)).resolves.toEqual([
      {
        source: "configured-pr-provenance",
        number: 19,
        html_url: "https://github.com/example/supervised/pull/19",
        head: { sha: pullRequestHeadSha },
      },
    ]);
    await expect(publicApi.getFile(regressionSha, sourcePath)).resolves.toEqual({
      source: "public-raw",
      type: "file",
      path: sourcePath,
      sha: "58477bb417f47e0edf26725e9638e781b69f124c",
      size: 11,
      content: "sequential\n",
    });

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(fetcher.mock.calls.every(([request]) => !request.headers.has("authorization"))).toBe(
      true,
    );
    expect(fetcher.mock.calls.map(([request]) => new URL(request.url).hostname)).toEqual([
      "patch-diff.githubusercontent.com",
      "raw.githubusercontent.com",
      "raw.githubusercontent.com",
      "raw.githubusercontent.com",
    ]);
    expect(fetcher.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      "/raw/example/supervised/pull/19.patch",
      `/example/supervised/${pullRequestHeadSha}/${sourcePath}`,
      `/example/supervised/${regressionSha}/${sourcePath}`,
      `/example/supervised/${regressionSha}/${sourcePath}`,
    ]);
  });

  it.each([
    {
      name: "mismatched immutable source",
      patch: pullRequestPatch(),
      content: (sha: string) => (sha === regressionSha ? "different\n" : "sequential\n"),
      code: "malformed-response",
    },
    {
      name: "wrong configured PR head",
      patch: pullRequestPatch({ headSha: "4444444444444444444444444444444444444444" }),
      content: () => "sequential\n",
      code: "malformed-response",
    },
    {
      name: "multiple PR commits",
      patch: pullRequestPatch({ secondCommit: true }),
      content: () => "sequential\n",
      code: "malformed-response",
    },
    {
      name: "unsafe changed path",
      patch: pullRequestPatch({ path: "workers/platform/src/api/../secret.ts" }),
      content: () => "sequential\n",
      code: "malformed-response",
    },
  ])("fails closed for $name", async ({ patch, content, code }) => {
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "patch-diff.githubusercontent.com") return new Response(patch);
      const sha = url.pathname.split("/")[3] ?? "";
      return new Response(content(sha));
    });

    await expect(api(fetcher).getCommit(regressionSha, 9)).rejects.toMatchObject({ code });
  });

  it("fails closed on oversized public evidence and invalid paths before unrelated I/O", async () => {
    const oversized = api(
      vi.fn(
        async () =>
          new Response("small", {
            headers: { "content-length": "101", "content-type": "text/plain" },
          }),
      ),
      100,
    );
    await expect(oversized.getCommit(regressionSha, 9)).rejects.toMatchObject({
      code: "limit-exceeded",
    });

    const fetcher = vi.fn(async () => new Response("must not run"));
    const pathGuard = api(fetcher);
    await expect(pathGuard.getFile(regressionSha, "../secrets.txt")).rejects.toMatchObject({
      code: "not-allowed",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
