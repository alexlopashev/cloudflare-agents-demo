import { describe, expect, it, vi } from "vitest";

import { GitHubPublicFetchApi } from "../../workers/platform/src/github/github-public-fetch-api";

const regressionSha = "1111111111111111111111111111111111111111";
const pullRequestHeadSha = "2222222222222222222222222222222222222222";
const pullRequestBaseSha = "3333333333333333333333333333333333333333";
const sourcePath = "workers/platform/src/api/health.ts";

function api(fetcher: (request: Request) => Promise<Response>, maxResponseBytes = 64_000) {
  return new GitHubPublicFetchApi({
    fetcher,
    repository: { owner: "example", repo: "supervised" },
    maxResponseBytes,
    provenance: {
      pullRequestNumber: 19,
      pullRequestBaseSha,
      pullRequestHeadSha,
      sourcePath,
    },
  });
}

function rawSourceFetcher(
  content: (reference: string) => string = (reference) =>
    reference === pullRequestBaseSha ? "concurrent\n" : "sequential\n",
) {
  return vi.fn(async (request: Request) => {
    const url = new URL(request.url);
    if (url.hostname !== "raw.githubusercontent.com") return new Response(null, { status: 404 });
    const reference = url.pathname.includes("/refs/pull/19/head/")
      ? "refs/pull/19/head"
      : (url.pathname.split("/")[3] ?? "");
    return new Response(content(reference), { headers: { "content-type": "text/plain" } });
  });
}

describe("GitHubPublicFetchApi", () => {
  it("proves one configured PR source through bounded raw ref and immutable source equality", async () => {
    const fetcher = rawSourceFetcher();
    const publicApi = api(fetcher);

    await expect(publicApi.getCommit(regressionSha, 1)).resolves.toEqual({
      source: "configured-pr-source",
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
          additions: null,
          deletions: null,
          metadata: {
            status: "partial",
            unknowns: ["additions", "deletions", "patch"],
          },
        },
      ],
    });
    await expect(publicApi.getPullRequestsForCommit(regressionSha, 1)).resolves.toEqual([
      {
        source: "configured-pr-source",
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

    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(fetcher.mock.calls.every(([request]) => !request.headers.has("authorization"))).toBe(
      true,
    );
    expect(fetcher.mock.calls.map(([request]) => new URL(request.url).hostname)).toEqual(
      Array.from({ length: 5 }, () => "raw.githubusercontent.com"),
    );
    expect(fetcher.mock.calls.map(([request]) => new URL(request.url).pathname)).toEqual([
      `/example/supervised/refs/pull/19/head/${sourcePath}`,
      `/example/supervised/${pullRequestBaseSha}/${sourcePath}`,
      `/example/supervised/${pullRequestHeadSha}/${sourcePath}`,
      `/example/supervised/${regressionSha}/${sourcePath}`,
      `/example/supervised/${regressionSha}/${sourcePath}`,
    ]);
  });

  it.each([
    {
      name: "PR ref does not match the configured head",
      content: (reference: string) =>
        reference === "refs/pull/19/head"
          ? "different\n"
          : reference === pullRequestBaseSha
            ? "concurrent\n"
            : "sequential\n",
    },
    {
      name: "configured base and head source are unchanged",
      content: () => "sequential\n",
    },
    {
      name: "regression source does not match the configured head",
      content: (reference: string) =>
        reference === pullRequestBaseSha
          ? "concurrent\n"
          : reference === regressionSha
            ? "different\n"
            : "sequential\n",
    },
  ])("fails closed when $name", async ({ content }) => {
    await expect(api(rawSourceFetcher(content)).getCommit(regressionSha, 1)).rejects.toMatchObject({
      code: "malformed-response",
    });
  });

  it("fails closed on oversized public source and invalid paths before unrelated I/O", async () => {
    const oversized = api(
      vi.fn(
        async () =>
          new Response("small", {
            headers: { "content-length": "101", "content-type": "text/plain" },
          }),
      ),
      100,
    );
    await expect(oversized.getCommit(regressionSha, 1)).rejects.toMatchObject({
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
