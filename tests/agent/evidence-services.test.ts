import { describe, expect, it, vi } from "vitest";

import { createAgentEvidenceServices } from "../../workers/platform/src/agent/evidence-services";

const regressionSha = "d591869a8ef995f1835ef80152f4de085b10255b";
const pullRequestHeadSha = "9af361e5a9420323b2c86f2670e3bf812ac58620";
const pullRequestBaseSha = "cf25e5253b106b1e7514340abe94bd42fd748725";

function telemetryStore() {
  const sourceEvidence = {
    releaseId: "regression-sequential",
    commitSha: regressionSha,
    commitSubject: "perf: serialize health checks to limit pressure (#19)",
    committedAt: "2026-07-12T01:42:21.000Z",
    pullRequestNumber: 19,
    pullRequestHeadSha,
    sourcePath: "workers/platform/src/api/health.ts",
    blobSha: "58477bb417f47e0edf26725e9638e781b69f124c",
    byteLength: 11,
    content: "sequential\n",
  } as const;
  return {
    compareReleases: vi.fn(async () => ({ status: "ready" })),
    findSlowTraces: vi.fn(async () => []),
    getTraceDetail: vi.fn(async () => null),
    getReleaseAttribution: vi.fn(async (releaseId: string) => ({
      versionId: releaseId,
      commitSha: regressionSha,
    })),
    getReleaseSourceEvidence: vi.fn(async () => sourceEvidence),
  };
}

describe("agent evidence services", () => {
  it("uses deterministic immutable repository evidence in credential-free fake mode", async () => {
    const store = telemetryStore();
    const fetcher = vi.fn(async () => new Response("network must not be used"));
    const services = createAgentEvidenceServices({
      mode: "fake",
      repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
      store,
      fetcher,
    });

    await expect(
      services.repository.inspectRelease("regression-sequential"),
    ).resolves.toMatchObject({
      release: { versionId: "regression-sequential", commitSha: regressionSha },
      commit: {
        sha: regressionSha,
        message: expect.stringContaining("serialize health checks"),
      },
      pullRequest: { status: "found", number: 19 },
    });
    await expect(
      services.repository.readFiles({
        commitSha: regressionSha,
        paths: ["workers/platform/src/api/health.ts"],
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        path: "workers/platform/src/api/health.ts",
        content: expect.stringContaining('loadingMode === "sequential"'),
      }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    undefined,
    "",
    "   ",
  ])("uses only persisted source evidence for a normalized absent token (%s)", async (token) => {
    const store = telemetryStore();
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.hostname === "raw.githubusercontent.com") {
        return new Response(
          url.pathname.includes(`/${pullRequestBaseSha}/`) ? "concurrent\n" : "sequential\n",
        );
      }
      return new Response("not found", { status: 404 });
    });
    const services = createAgentEvidenceServices({
      mode: "workers-ai",
      repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
      store,
      fetcher,
      ...(token === undefined ? {} : { token }),
    });

    await expect(
      services.repository.inspectRelease("regression-sequential"),
    ).resolves.toMatchObject({
      commit: {
        sha: regressionSha,
        message: "perf: serialize health checks to limit pressure (#19)",
        committedAt: "2026-07-12T01:42:21.000Z",
        authorLogin: null,
      },
      pullRequest: {
        status: "found",
        number: 19,
        headSha: pullRequestHeadSha,
      },
    });
    await expect(
      services.repository.readFiles({
        commitSha: regressionSha,
        paths: ["workers/platform/src/api/health.ts"],
      }),
    ).resolves.toMatchObject([
      { path: "workers/platform/src/api/health.ts", content: "sequential\n" },
    ]);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("keeps a non-empty token on the bounded REST read adapter", async () => {
    const store = telemetryStore();
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname.endsWith(`/commits/${regressionSha}`)) {
        return Response.json({
          sha: regressionSha,
          html_url: `https://github.com/alexlopashev/cloudflare-agents-demo/commit/${regressionSha}`,
          commit: {
            message: "perf: serialize health checks",
            committer: { date: "2026-07-12T01:42:21Z" },
          },
          author: { login: "alexlopashev" },
          files: [
            {
              filename: "workers/platform/src/api/health.ts",
              status: "modified",
              additions: 14,
              deletions: 4,
            },
          ],
        });
      }
      return Response.json([
        {
          number: 19,
          title: "Scenario: serialize health checks",
          html_url: "https://github.com/alexlopashev/cloudflare-agents-demo/pull/19",
          state: "closed",
          merged_at: "2026-07-12T01:42:21Z",
          user: { login: "alexlopashev" },
          base: { sha: "cf25e5253b106b1e7514340abe94bd42fd748725" },
          head: { sha: regressionSha },
        },
      ]);
    });
    const services = createAgentEvidenceServices({
      mode: "workers-ai",
      repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
      store,
      fetcher,
      token: "scoped-read-token",
    });

    await expect(
      services.repository.inspectRelease("regression-sequential"),
    ).resolves.toMatchObject({ pullRequest: { status: "found", number: 19 } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(
      fetcher.mock.calls.every(([request]) => new URL(request.url).hostname === "api.github.com"),
    ).toBe(true);
    expect(
      fetcher.mock.calls.every(
        ([request]) => request.headers.get("authorization") === "Bearer scoped-read-token",
      ),
    ).toBe(true);
  });

  it("fails closed for mismatched fake attribution and unsupported modes", async () => {
    const store = telemetryStore();
    store.getReleaseAttribution.mockResolvedValue({
      versionId: "regression-sequential",
      commitSha: "1111111111111111111111111111111111111111",
    });
    const fake = createAgentEvidenceServices({
      mode: "fake",
      repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
      store,
    });

    await expect(fake.repository.inspectRelease("regression-sequential")).rejects.toMatchObject({
      code: "malformed-response",
    });
    expect(() =>
      createAgentEvidenceServices({
        mode: "unsupported",
        repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
        store,
      }),
    ).toThrow("Unsupported evidence mode");
  });
});
