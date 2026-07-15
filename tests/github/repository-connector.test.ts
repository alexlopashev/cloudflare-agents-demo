import { describe, expect, it, vi } from "vitest";

import {
  RepositoryConnector,
  RepositoryConnectorError,
  type GitHubRepositoryApi,
  type ReleaseSource,
} from "../../workers/platform/src/github/repository-connector";

const commitSha = "1111111111111111111111111111111111111111";
const blobSha = "2222222222222222222222222222222222222222";

function commitPayload(overrides: Record<string, unknown> = {}) {
  return {
    sha: commitSha,
    html_url: `https://github.com/example/supervised/commit/${commitSha}`,
    commit: {
      message: "Slow the service grid",
      committer: { date: "2026-07-11T18:00:00Z" },
    },
    author: { login: "octocat" },
    files: [
      {
        filename: "apps/web/src/services.ts",
        status: "modified",
        additions: 4,
        deletions: 2,
        patch: "@@ -1 +1 @@\n-fast\n+slow",
      },
    ],
    ...overrides,
  };
}

function pullRequestPayload() {
  return {
    number: 42,
    title: "Introduce the regression fixture",
    html_url: "https://github.com/example/supervised/pull/42",
    state: "closed",
    merged_at: "2026-07-11T17:55:00Z",
    user: { login: "octocat" },
    base: { sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
    head: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
  };
}

function filePayload(path: string, content: string) {
  const bytes = new TextEncoder().encode(content);
  return {
    type: "file",
    path,
    sha: blobSha,
    size: bytes.byteLength,
    encoding: "base64",
    content: btoa(String.fromCharCode(...bytes)),
  };
}

function createConnector(
  options: {
    api?: Partial<GitHubRepositoryApi>;
    releases?: ReleaseSource;
    limits?: Partial<{
      maxApiResponseBytes: number;
      maxChangedFiles: number;
      maxFiles: number;
      maxFileBytes: number;
      maxPatchBytes: number;
      maxTotalBytes: number;
    }>;
  } = {},
) {
  const api: GitHubRepositoryApi = {
    repository: { owner: "example", repo: "supervised" },
    maxResponseBytes: 64_000,
    getCommit: vi.fn(async () => commitPayload()),
    getFile: vi.fn(async (_sha, path) => filePayload(path, "export const fast = true;\n")),
    getPullRequestsForCommit: vi.fn(async () => [pullRequestPayload()]),
    ...options.api,
  };
  const releases: ReleaseSource =
    options.releases ??
    ({
      resolve: vi.fn(async () => ({ versionId: "release-bad", commitSha })),
    } satisfies ReleaseSource);

  return {
    api,
    connector: new RepositoryConnector({
      api,
      releases,
      repository: { owner: "example", repo: "supervised" },
      allowedPathPrefixes: ["apps/", "workers/", "packages/"],
      limits: {
        maxApiResponseBytes: 64_000,
        maxChangedFiles: 8,
        maxFiles: 3,
        maxFileBytes: 100,
        maxPatchBytes: 2_000,
        maxTotalBytes: 180,
        ...options.limits,
      },
    }),
    releases,
  };
}

describe("RepositoryConnector", () => {
  it("resolves a configured release to immutable commit and associated PR evidence", async () => {
    const { api, connector } = createConnector();

    await expect(connector.inspectRelease("release-bad")).resolves.toEqual({
      release: { versionId: "release-bad", commitSha },
      commit: {
        sha: commitSha,
        message: "Slow the service grid",
        committedAt: "2026-07-11T18:00:00Z",
        authorLogin: "octocat",
        url: `https://github.com/example/supervised/commit/${commitSha}`,
        changes: [
          {
            path: "apps/web/src/services.ts",
            status: "modified",
            additions: 4,
            deletions: 2,
            patch: "@@ -1 +1 @@\n-fast\n+slow",
          },
        ],
      },
      pullRequest: {
        status: "found",
        number: 42,
        title: "Introduce the regression fixture",
        authorLogin: "octocat",
        baseSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        mergedAt: "2026-07-11T17:55:00Z",
        url: "https://github.com/example/supervised/pull/42",
      },
    });
    expect(api.getCommit).toHaveBeenCalledWith(commitSha, 9);
    expect(api.getPullRequestsForCommit).toHaveBeenCalledWith(commitSha, 11);
  });

  it("represents missing and ambiguous PR metadata as explicit unknowns", async () => {
    const missing = createConnector({
      api: { getPullRequestsForCommit: vi.fn(async () => []) },
    }).connector;
    const ambiguous = createConnector({
      api: {
        getPullRequestsForCommit: vi.fn(async () => [pullRequestPayload(), pullRequestPayload()]),
      },
    }).connector;

    await expect(missing.inspectRelease("release-bad")).resolves.toMatchObject({
      pullRequest: { status: "unknown", reason: "not-found" },
    });
    await expect(ambiguous.inspectRelease("release-bad")).resolves.toMatchObject({
      pullRequest: { status: "unknown", reason: "ambiguous" },
    });
  });

  it("keeps unavailable public patch PR metadata explicitly partial", async () => {
    const connector = createConnector({
      api: {
        getPullRequestsForCommit: vi.fn(async () => [
          {
            source: "public-patch",
            number: 42,
            commitSubject: "Introduce the regression fixture",
            html_url: "https://github.com/example/supervised/pull/42",
            head: { sha: commitSha },
          },
        ]),
      },
    }).connector;

    await expect(connector.inspectRelease("release-bad")).resolves.toMatchObject({
      pullRequest: {
        status: "found",
        number: 42,
        title: null,
        headSha: commitSha,
        metadata: {
          status: "partial",
          unknowns: ["title", "author-login", "base-sha", "merged-at"],
        },
      },
    });
  });

  it("keeps configured provenance commit metadata explicitly partial", async () => {
    const connector = createConnector({
      api: {
        getCommit: vi.fn(async () => ({
          source: "configured-pr-source",
          sha: commitSha,
          html_url: `https://github.com/example/supervised/commit/${commitSha}`,
          metadata: {
            status: "partial",
            unknowns: ["message", "committed-at", "author-login"],
          },
          files: [
            {
              filename: "apps/web/src/services.ts",
              status: "modified",
              additions: null,
              deletions: null,
              metadata: {
                status: "partial",
                unknowns: ["additions", "deletions", "patch"],
              },
            },
          ],
        })),
        getPullRequestsForCommit: vi.fn(async () => [
          {
            source: "configured-pr-source",
            number: 42,
            html_url: "https://github.com/example/supervised/pull/42",
            head: { sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb" },
          },
        ]),
      },
    }).connector;

    await expect(connector.inspectRelease("release-bad")).resolves.toMatchObject({
      commit: {
        sha: commitSha,
        message: null,
        committedAt: null,
        authorLogin: null,
        metadata: {
          status: "partial",
          unknowns: ["message", "committed-at", "author-login"],
        },
        changes: [
          {
            path: "apps/web/src/services.ts",
            status: "modified",
            additions: null,
            deletions: null,
            metadata: {
              status: "partial",
              unknowns: ["additions", "deletions", "patch"],
            },
          },
        ],
      },
      pullRequest: {
        status: "found",
        number: 42,
        title: null,
        headSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        metadata: {
          status: "partial",
          unknowns: ["title", "author-login", "base-sha", "merged-at"],
        },
      },
    });
  });

  it("rejects mutable refs, traversal, encoded traversal, and disallowed paths before I/O", async () => {
    const { api, connector } = createConnector();

    for (const request of [
      { commitSha: "main", paths: ["apps/web/src/services.ts"] },
      { commitSha, paths: ["../secrets.txt"] },
      { commitSha, paths: ["apps/%2e%2e/secrets.txt"] },
      { commitSha, paths: ["apps\\web\\src\\services.ts"] },
      { commitSha, paths: [".github/workflows/deploy.yml"] },
    ]) {
      await expect(connector.readFiles(request)).rejects.toBeInstanceOf(RepositoryConnectorError);
    }
    expect(api.getFile).not.toHaveBeenCalled();
  });

  it("enforces file count, per-file bytes, and aggregate bytes", async () => {
    const countLimited = createConnector({ limits: { maxFiles: 1 } }).connector;
    await expect(
      countLimited.readFiles({
        commitSha,
        paths: ["apps/web/src/a.ts", "apps/web/src/b.ts"],
      }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });

    const fileLimited = createConnector({
      limits: { maxFileBytes: 4 },
      api: { getFile: vi.fn(async (_sha, path) => filePayload(path, "12345")) },
    }).connector;
    await expect(
      fileLimited.readFiles({ commitSha, paths: ["apps/web/src/a.ts"] }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });

    const aggregateLimited = createConnector({
      limits: { maxTotalBytes: 8 },
      api: { getFile: vi.fn(async (_sha, path) => filePayload(path, "12345")) },
    }).connector;
    await expect(
      aggregateLimited.readFiles({
        commitSha,
        paths: ["apps/web/src/a.ts", "apps/web/src/b.ts"],
      }),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
  });

  it("returns validated text files in request order with immutable blob evidence", async () => {
    const { connector } = createConnector({
      api: { getFile: vi.fn(async (_sha, path) => filePayload(path, `content:${path}`)) },
    });

    await expect(
      connector.readFiles({
        commitSha,
        paths: ["workers/platform/src/index.ts", "apps/web/src/App.tsx"],
      }),
    ).resolves.toEqual([
      {
        path: "workers/platform/src/index.ts",
        blobSha,
        byteLength: 37,
        content: "content:workers/platform/src/index.ts",
      },
      {
        path: "apps/web/src/App.tsx",
        blobSha,
        byteLength: 28,
        content: "content:apps/web/src/App.tsx",
      },
    ]);
  });

  it("fails closed on malformed release, commit, PR, and file payloads", async () => {
    const cases = [
      createConnector({
        releases: { resolve: vi.fn(async () => ({ versionId: "release-bad", commitSha: "main" })) },
      }).connector.inspectRelease("release-bad"),
      createConnector({
        api: { getCommit: vi.fn(async () => ({ sha: commitSha })) },
      }).connector.inspectRelease("release-bad"),
      createConnector({
        api: { getPullRequestsForCommit: vi.fn(async () => [{ number: "42" }]) },
      }).connector.inspectRelease("release-bad"),
      createConnector({
        api: {
          getFile: vi.fn(async () => ({ ...filePayload("apps/web/src/a.ts", "ok"), size: 99 })),
        },
      }).connector.readFiles({ commitSha, paths: ["apps/web/src/a.ts"] }),
    ];

    for (const operation of cases) {
      await expect(operation).rejects.toMatchObject({ code: "malformed-response" });
    }
  });

  it("accepts additional GitHub fields while validating the required boundary", async () => {
    const connector = createConnector({
      api: {
        getCommit: vi.fn(async () => ({
          ...commitPayload(),
          node_id: "commit-node",
          commit: {
            message: "Slow the service grid",
            committer: { date: "2026-07-11T18:00:00Z", name: "Example" },
            author: { name: "Example" },
          },
        })),
        getPullRequestsForCommit: vi.fn(async () => [
          { ...pullRequestPayload(), node_id: "pr-node", labels: [] },
        ]),
        getFile: vi.fn(async (_sha, path) => ({
          ...filePayload(path, "ok"),
          url: "https://api.github.com/repos/example/supervised/contents/file",
        })),
      },
    }).connector;

    await expect(connector.inspectRelease("release-bad")).resolves.toMatchObject({
      commit: { sha: commitSha },
      pullRequest: { status: "found", number: 42 },
    });
    await expect(
      connector.readFiles({ commitSha, paths: ["apps/web/src/a.ts"] }),
    ).resolves.toMatchObject([{ content: "ok" }]);
  });

  it("rejects an API adapter configured for a different repository or response budget", () => {
    const base = createConnector();
    const wrongRepository = {
      ...base.api,
      repository: { owner: "attacker", repo: "other" },
    } satisfies GitHubRepositoryApi;
    const unbounded = {
      ...base.api,
      maxResponseBytes: 64_001,
    } satisfies GitHubRepositoryApi;

    for (const api of [wrongRepository, unbounded]) {
      expect(
        () =>
          new RepositoryConnector({
            api,
            releases: base.releases,
            repository: { owner: "example", repo: "supervised" },
            allowedPathPrefixes: ["apps/"],
            limits: {
              maxApiResponseBytes: 64_000,
              maxChangedFiles: 8,
              maxFiles: 3,
              maxFileBytes: 100,
              maxPatchBytes: 2_000,
              maxTotalBytes: 180,
            },
          }),
      ).toThrow(RepositoryConnectorError);
    }
  });

  it("rejects unsafe change paths and evidence URLs from GitHub", async () => {
    const unsafeChange = createConnector({
      api: {
        getCommit: vi.fn(async () =>
          commitPayload({
            files: [{ ...commitPayload().files[0], filename: "apps/../secrets.txt" }],
          }),
        ),
      },
    }).connector;
    const wrongCommitUrl = createConnector({
      api: {
        getCommit: vi.fn(async () => commitPayload({ html_url: "https://evil.test/commit" })),
      },
    }).connector;
    const wrongPullRequestUrl = createConnector({
      api: {
        getPullRequestsForCommit: vi.fn(async () => [
          { ...pullRequestPayload(), html_url: "https://evil.test/pull/42" },
        ]),
      },
    }).connector;

    for (const connector of [unsafeChange, wrongCommitUrl, wrongPullRequestUrl]) {
      await expect(connector.inspectRelease("release-bad")).rejects.toMatchObject({
        code: "malformed-response",
      });
    }
  });

  it("accepts GitHub line wrapping for a file exactly at the byte limit", async () => {
    const content = "x".repeat(1_000);
    const payload = filePayload("apps/web/src/large.ts", content);
    payload.content = payload.content.match(/.{1,60}/g)?.join("\n") ?? payload.content;
    const connector = createConnector({
      limits: { maxFileBytes: 1_000, maxTotalBytes: 1_000 },
      api: { getFile: vi.fn(async () => payload) },
    }).connector;

    await expect(
      connector.readFiles({ commitSha, paths: ["apps/web/src/large.ts"] }),
    ).resolves.toMatchObject([{ byteLength: 1_000, content }]);
  });

  it("preserves explicit release lookup failures without fabricating evidence", async () => {
    const notFound = new RepositoryConnectorError("not-found", "Release was not found.");
    const connector = createConnector({
      releases: { resolve: vi.fn(async () => Promise.reject(notFound)) },
    }).connector;

    await expect(connector.inspectRelease("release-missing")).rejects.toBe(notFound);
  });

  it("maps unexpected API failures to bounded availability errors", async () => {
    const inspect = createConnector({
      api: { getCommit: vi.fn(async () => Promise.reject(new Error("secret transport detail"))) },
    }).connector;
    const read = createConnector({
      api: { getFile: vi.fn(async () => Promise.reject(new Error("secret transport detail"))) },
    }).connector;

    await expect(inspect.inspectRelease("release-bad")).rejects.toEqual(
      new RepositoryConnectorError("unavailable", "GitHub commit request is unavailable."),
    );
    await expect(read.readFiles({ commitSha, paths: ["apps/web/src/a.ts"] })).rejects.toEqual(
      new RepositoryConnectorError("unavailable", "GitHub file request is unavailable."),
    );
  });

  it("enforces diff file and patch byte limits", async () => {
    const tooMany = createConnector({
      limits: { maxChangedFiles: 1 },
      api: {
        getCommit: vi.fn(async () =>
          commitPayload({
            files: [
              commitPayload().files[0],
              { ...commitPayload().files[0], filename: "apps/web/src/other.ts" },
            ],
          }),
        ),
      },
    }).connector;
    await expect(tooMany.inspectRelease("release-bad")).rejects.toMatchObject({
      code: "limit-exceeded",
    });

    const patchTooLarge = createConnector({
      limits: { maxPatchBytes: 3 },
    }).connector;
    await expect(patchTooLarge.inspectRelease("release-bad")).rejects.toMatchObject({
      code: "limit-exceeded",
    });
  });

  it("applies the patch byte limit only to allowlisted evidence", async () => {
    const connector = createConnector({
      limits: { maxPatchBytes: 32 },
      api: {
        getCommit: vi.fn(async () =>
          commitPayload({
            files: [
              commitPayload().files[0],
              {
                ...commitPayload().files[0],
                filename: "README.md",
                patch: "x".repeat(4_000),
              },
            ],
          }),
        ),
      },
    }).connector;

    await expect(connector.inspectRelease("release-bad")).resolves.toMatchObject({
      commit: { changes: [{ path: "apps/web/src/services.ts" }] },
    });
  });
});
