import { describe, expect, it } from "vitest";

import { DeterministicGitHubFixture } from "../../packages/test-fixtures/src/github";
import { GitHubFetchApi, RepositoryConnector } from "../../workers/platform/src/github";

const commitSha = "1111111111111111111111111111111111111111";
const blobSha = "2222222222222222222222222222222222222222";

describe("repository connector integration", () => {
  it("uses deterministic GitHub transport and release fixtures end to end", async () => {
    const fixture = new DeterministicGitHubFixture({
      releases: { "release-bad": commitSha },
      responses: {
        [`/repos/example/supervised/commits/${commitSha}?per_page=9`]: {
          sha: commitSha,
          html_url: `https://github.com/example/supervised/commit/${commitSha}`,
          commit: {
            message: "Regression fixture",
            committer: { date: "2026-07-11T18:00:00Z" },
          },
          author: null,
          files: [],
        },
        [`/repos/example/supervised/commits/${commitSha}/pulls?per_page=11`]: [],
        [`/repos/example/supervised/contents/apps/web/src/App.tsx?ref=${commitSha}`]: {
          type: "file",
          path: "apps/web/src/App.tsx",
          sha: blobSha,
          size: 2,
          encoding: "base64",
          content: "b2s=",
        },
      },
    });
    const api = new GitHubFetchApi({
      fetcher: fixture.fetch,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 16_000,
    });
    const connector = new RepositoryConnector({
      api,
      releases: fixture.releaseSource,
      repository: { owner: "example", repo: "supervised" },
      allowedPathPrefixes: ["apps/"],
      limits: {
        maxApiResponseBytes: 16_000,
        maxChangedFiles: 8,
        maxFiles: 2,
        maxFileBytes: 1_000,
        maxPatchBytes: 4_000,
        maxTotalBytes: 1_000,
      },
    });

    await expect(connector.inspectRelease("release-bad")).resolves.toMatchObject({
      release: { versionId: "release-bad", commitSha },
      pullRequest: { status: "unknown", reason: "not-found" },
    });
    await expect(
      connector.readFiles({ commitSha, paths: ["apps/web/src/App.tsx"] }),
    ).resolves.toEqual([
      {
        path: "apps/web/src/App.tsx",
        blobSha,
        byteLength: 2,
        content: "ok",
      },
    ]);
    expect(fixture.requests).toEqual([
      `/repos/example/supervised/commits/${commitSha}?per_page=9`,
      `/repos/example/supervised/commits/${commitSha}/pulls?per_page=11`,
      `/repos/example/supervised/contents/apps/web/src/App.tsx?ref=${commitSha}`,
    ]);
  });
});
