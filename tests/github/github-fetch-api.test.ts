import { describe, expect, it, vi } from "vitest";

import {
  GitHubFetchApi,
  RepositoryConnectorError,
} from "../../workers/platform/src/github/github-fetch-api";

const commitSha = "1111111111111111111111111111111111111111";

describe("GitHubFetchApi", () => {
  it("identifies every credential-free request with the fixed product user agent", async () => {
    const fetcher = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    const api = new GitHubFetchApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 1_024,
    });

    await api.getCommit(commitSha, 1);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(fetcher.mock.calls[0]?.[0].headers.get("user-agent")).toBe("Regression-Surgeon");
    expect(fetcher.mock.calls[0]?.[0].headers.has("authorization")).toBe(false);
  });

  it("invokes a Workers-compatible fetcher without changing its receiver", async () => {
    async function receiverSensitiveFetcher(this: unknown, _request: Request) {
      if (this !== undefined) throw new TypeError("Illegal invocation");
      return Response.json({ ok: true });
    }
    const api = new GitHubFetchApi({
      fetcher: receiverSensitiveFetcher,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 1_024,
    });

    await expect(api.getCommit(commitSha, 1)).resolves.toEqual({ ok: true });
  });

  it("addresses only the configured repository and pins file reads to a commit", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      void request;
      return Response.json({ ok: true });
    });
    const api = new GitHubFetchApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 1_024,
      token: "test-token",
    });

    await api.getCommit(commitSha, 9);
    await api.getPullRequestsForCommit(commitSha, 11);
    await api.getFile(commitSha, "apps/web/src/services grid.ts");

    expect(fetcher.mock.calls.map(([request]) => new URL(request.url).toString())).toEqual([
      `https://api.github.com/repos/example/supervised/commits/${commitSha}?per_page=9`,
      `https://api.github.com/repos/example/supervised/commits/${commitSha}/pulls?per_page=11`,
      `https://api.github.com/repos/example/supervised/contents/apps/web/src/services%20grid.ts?ref=${commitSha}`,
    ]);
    expect(fetcher.mock.calls[0]?.[0].headers.get("authorization")).toBe("Bearer test-token");
  });

  it("surfaces rate limiting without returning an unbounded error body", async () => {
    const api = new GitHubFetchApi({
      fetcher: vi.fn(
        async () =>
          new Response("x".repeat(10_000), {
            status: 403,
            headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": "1783818000" },
          }),
      ),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });

    await expect(api.getCommit(commitSha, 1)).rejects.toEqual(
      expect.objectContaining({ code: "rate-limited", retryAtEpochSeconds: 1_783_818_000 }),
    );
  });

  it("rejects declared and streamed responses beyond the byte budget", async () => {
    const declared = new GitHubFetchApi({
      fetcher: vi.fn(
        async () =>
          new Response("{}", {
            headers: { "content-length": "101", "content-type": "application/json" },
          }),
      ),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });
    await expect(declared.getCommit(commitSha, 1)).rejects.toMatchObject({
      code: "limit-exceeded",
    });

    const streamed = new GitHubFetchApi({
      fetcher: vi.fn(async () => Response.json({ body: "x".repeat(101) })),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });
    await expect(streamed.getCommit(commitSha, 1)).rejects.toMatchObject({
      code: "limit-exceeded",
    });
  });

  it("maps non-rate-limit HTTP and invalid JSON failures to bounded errors", async () => {
    const unavailable = new GitHubFetchApi({
      fetcher: vi.fn(async () => new Response("secret upstream detail", { status: 500 })),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });
    await expect(unavailable.getCommit(commitSha, 1)).rejects.toEqual(
      new RepositoryConnectorError("unavailable", "GitHub request failed with HTTP 500."),
    );

    const malformed = new GitHubFetchApi({
      fetcher: vi.fn(async () => new Response("not-json", { status: 200 })),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });
    await expect(malformed.getCommit(commitSha, 1)).rejects.toMatchObject({
      code: "malformed-response",
    });
  });

  it("rejects unsafe file paths before issuing a request", async () => {
    const fetcher = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    const api = new GitHubFetchApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });

    for (const path of ["../issues", "/absolute.ts", "apps/../secret.ts", "apps\\file.ts", ""]) {
      await expect(api.getFile(commitSha, path)).rejects.toMatchObject({ code: "not-allowed" });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid page sizes before issuing a request", async () => {
    const fetcher = vi.fn(async (_request: Request) => Response.json({ ok: true }));
    const api = new GitHubFetchApi({
      fetcher,
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });

    for (const pageSize of [0, 101, 1.5]) {
      await expect(api.getCommit(commitSha, pageSize)).rejects.toMatchObject({
        code: "invalid-input",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid content lengths and maps stream failures to bounded availability errors", async () => {
    const invalidLength = new GitHubFetchApi({
      fetcher: vi.fn(async () => new Response("{}", { headers: { "content-length": "-1" } })),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });
    await expect(invalidLength.getCommit(commitSha, 1)).rejects.toMatchObject({
      code: "malformed-response",
    });

    const failedStream = new GitHubFetchApi({
      fetcher: vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.error(new Error("upstream stream failed"));
              },
            }),
          ),
      ),
      repository: { owner: "example", repo: "supervised" },
      maxResponseBytes: 100,
    });
    await expect(failedStream.getCommit(commitSha, 1)).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});
