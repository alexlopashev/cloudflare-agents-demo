import { describe, expect, it, vi } from "vitest";

import { GitHubDraftPrApi } from "../../workers/platform/src/github/draft-pr-api";

const baseSha = "1".repeat(40);
const treeSha = "2".repeat(40);
const blobSha = "3".repeat(40);
const commitSha = "4".repeat(40);

describe("GitHubDraftPrApi", () => {
  it("uses only configured-repository draft-PR endpoints with bounded authenticated requests", async () => {
    const requests: { method: string; url: string; body: unknown }[] = [];
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      const body = request.body === null ? null : await request.json();
      requests.push({ method: request.method, url: `${url.pathname}${url.search}`, body });
      if (url.pathname.endsWith("/git/ref/heads/main")) {
        return Response.json({ object: { sha: baseSha } });
      }
      if (url.pathname.endsWith(`/git/commits/${baseSha}`)) {
        return Response.json({ sha: baseSha, tree: { sha: treeSha } });
      }
      if (url.pathname.includes("/contents/")) {
        return Response.json({
          type: "file",
          path: "workers/platform/src/api/health.ts",
          sha: blobSha,
          size: 2,
          encoding: "base64",
          content: "b2s=",
        });
      }
      if (url.pathname.endsWith("/pulls") && request.method === "GET") return Response.json([]);
      if (url.pathname.includes("/git/ref/heads/regression-surgeon")) {
        return new Response("not found", { status: 404 });
      }
      if (url.pathname.includes("/compare/")) {
        return Response.json({
          status: "ahead",
          ahead_by: 1,
          behind_by: 0,
          total_commits: 1,
          base_commit: { sha: baseSha },
          commits: [{ sha: commitSha }],
          files: [{ filename: "workers/platform/src/api/health.ts" }],
        });
      }
      if (url.pathname.endsWith("/git/blobs")) return Response.json({ sha: blobSha });
      if (url.pathname.endsWith("/git/trees")) return Response.json({ sha: treeSha });
      if (url.pathname.endsWith("/git/commits")) return Response.json({ sha: commitSha });
      if (url.pathname.endsWith("/git/refs")) {
        const ref = body as { ref: string; sha: string };
        return Response.json({ ref: ref.ref, object: { sha: ref.sha } });
      }
      if (url.pathname.endsWith("/pulls") && request.method === "POST") {
        return Response.json({
          number: 21,
          html_url: "https://github.com/example/supervised/pull/21",
          draft: true,
        });
      }
      return new Response("unexpected", { status: 500 });
    });
    const api = new GitHubDraftPrApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      allowedPaths: ["workers/platform/src/api/health.ts"],
      maxResponseBytes: 4_096,
      token: "scoped-token",
    });

    await expect(api.getBase("main")).resolves.toEqual({ sha: baseSha, treeSha });
    await expect(api.getFile(baseSha, "workers/platform/src/api/health.ts")).resolves.toEqual({
      blobSha,
      content: "ok",
    });
    await expect(api.findOpenDraftPullRequest("regression-surgeon/abcdef0123456789")).resolves.toBe(
      null,
    );
    await expect(api.getBranch("regression-surgeon/abcdef0123456789")).resolves.toBe(null);
    await expect(api.getChangedPaths(baseSha, commitSha)).resolves.toEqual([
      "workers/platform/src/api/health.ts",
    ]);
    await expect(api.createBlob("replacement")).resolves.toEqual({ sha: blobSha });
    await expect(
      api.createTree({
        baseTreeSha: treeSha,
        path: "workers/platform/src/api/health.ts",
        blobSha,
      }),
    ).resolves.toEqual({ sha: treeSha });
    await expect(
      api.createCommit({ message: "fix: bounded concurrency", treeSha, parentSha: baseSha }),
    ).resolves.toEqual({ sha: commitSha });
    await expect(
      api.createBranch("regression-surgeon/abcdef0123456789", commitSha),
    ).resolves.toBeUndefined();
    await expect(
      api.createDraftPullRequest({
        title: "fix: bounded concurrency",
        body: "evidence",
        head: "regression-surgeon/abcdef0123456789",
        base: "main",
      }),
    ).resolves.toEqual({
      number: 21,
      url: "https://github.com/example/supervised/pull/21",
      draft: true,
    });

    expect(requests).toEqual([
      { method: "GET", url: "/repos/example/supervised/git/ref/heads/main", body: null },
      { method: "GET", url: `/repos/example/supervised/git/commits/${baseSha}`, body: null },
      {
        method: "GET",
        url: `/repos/example/supervised/contents/workers/platform/src/api/health.ts?ref=${baseSha}`,
        body: null,
      },
      {
        method: "GET",
        url: "/repos/example/supervised/pulls?state=open&head=example%3Aregression-surgeon%2Fabcdef0123456789&per_page=2",
        body: null,
      },
      {
        method: "GET",
        url: "/repos/example/supervised/git/ref/heads/regression-surgeon%2Fabcdef0123456789",
        body: null,
      },
      {
        method: "GET",
        url: `/repos/example/supervised/compare/${baseSha}...${commitSha}`,
        body: null,
      },
      {
        method: "POST",
        url: "/repos/example/supervised/git/blobs",
        body: { content: "replacement", encoding: "utf-8" },
      },
      {
        method: "POST",
        url: "/repos/example/supervised/git/trees",
        body: {
          base_tree: treeSha,
          tree: [
            {
              path: "workers/platform/src/api/health.ts",
              mode: "100644",
              type: "blob",
              sha: blobSha,
            },
          ],
        },
      },
      {
        method: "POST",
        url: "/repos/example/supervised/git/commits",
        body: { message: "fix: bounded concurrency", tree: treeSha, parents: [baseSha] },
      },
      {
        method: "POST",
        url: "/repos/example/supervised/git/refs",
        body: { ref: "refs/heads/regression-surgeon/abcdef0123456789", sha: commitSha },
      },
      {
        method: "POST",
        url: "/repos/example/supervised/pulls",
        body: {
          title: "fix: bounded concurrency",
          body: "evidence",
          head: "regression-surgeon/abcdef0123456789",
          base: "main",
          draft: true,
        },
      },
    ]);
    expect(
      fetcher.mock.calls.every(
        ([request]) => request.headers.get("authorization") === "Bearer scoped-token",
      ),
    ).toBe(true);
    expect(Object.getOwnPropertyNames(GitHubDraftPrApi.prototype)).not.toContain("merge");
  });

  it("allows anonymous reads but fails closed on unauthenticated writes and unsafe input", async () => {
    const anonymousFetcher = vi.fn(async (request: Request) => {
      expect(request.headers.has("authorization")).toBe(false);
      return Response.json({ object: { sha: baseSha } });
    });
    const anonymous = new GitHubDraftPrApi({
      fetcher: anonymousFetcher,
      repository: { owner: "example", repo: "supervised" },
      allowedPaths: ["workers/platform/src/api/health.ts"],
      maxResponseBytes: 100,
    });
    await expect(anonymous.createBlob("replacement")).rejects.toMatchObject({
      code: "not-allowed",
    });
    expect(anonymousFetcher).not.toHaveBeenCalled();

    const fetcher = vi.fn(async () => Response.json({ body: "x".repeat(200) }));
    const api = new GitHubDraftPrApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      allowedPaths: ["workers/platform/src/api/health.ts"],
      maxResponseBytes: 100,
      token: "token",
    });
    await expect(api.getFile(baseSha, ".github/workflows/ci.yml")).rejects.toMatchObject({
      code: "not-allowed",
    });
    await expect(api.getBase("main")).rejects.toMatchObject({ code: "limit-exceeded" });

    const malformedWrite = new GitHubDraftPrApi({
      fetcher: vi.fn(async () => Response.json({ ref: "refs/heads/wrong" })),
      repository: { owner: "example", repo: "supervised" },
      allowedPaths: ["workers/platform/src/api/health.ts"],
      maxResponseBytes: 1_024,
      token: "token",
    });
    await expect(
      malformedWrite.createBranch("regression-surgeon/abcdef", commitSha),
    ).rejects.toMatchObject({
      code: "malformed-response",
    });
  });
});
