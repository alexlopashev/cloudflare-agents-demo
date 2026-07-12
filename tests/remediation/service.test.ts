import { describe, expect, it, vi } from "vitest";

import {
  createRemediationService,
  RemediationError,
  type DraftPullRequestApi,
  type RemediationProposal,
} from "../../workers/platform/src/remediation/service";

const regressionSha = "d591869a8ef995f1835ef80152f4de085b10255b";
const blobSha = "0cd08624a8881809bd6f0d55a4ec88b358daec64";
const original = `const mode = "sequential";
const result = await first();
const next = await second();`;
const replacement = `const mode = "bounded-concurrency";
const [result, next] = await Promise.all([first(), second()]);`;

function proposal(overrides: Partial<RemediationProposal> = {}): RemediationProposal {
  return {
    incident: {
      baselineReleaseId: "baseline-concurrent",
      degradedReleaseId: "regression-sequential",
      traceId: "scenario-trace-34",
      regressionCommitSha: regressionSha,
      sourcePullRequestNumber: 19,
    },
    expectedBaseSha: regressionSha,
    expectedBlobSha: blobSha,
    path: "workers/platform/src/api/health.ts",
    replacementContent: replacement,
    title: "fix: bound health-check concurrency",
    rationale: "Preserve downstream pressure control without serializing the full critical path.",
    risk: "A bound of two still permits overlapping dependency requests.",
    validationSteps: ["Run mise run check", "Run mise run e2e"],
    ...overrides,
  };
}

function apiFixture() {
  const state: {
    branch: { sha: string } | null;
    branchContent: string;
    pullRequest: { number: number; url: string; draft: boolean } | null;
  } = { branch: null, branchContent: replacement, pullRequest: null };
  const api: DraftPullRequestApi = {
    repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
    getBase: vi.fn(async () => ({ sha: regressionSha, treeSha: "1".repeat(40) })),
    getFile: vi.fn(async (ref: string) => ({
      blobSha: ref.startsWith("regression-surgeon/") ? "2".repeat(40) : blobSha,
      content: ref.startsWith("regression-surgeon/") ? state.branchContent : original,
    })),
    findOpenDraftPullRequest: vi.fn(async () => state.pullRequest),
    getBranch: vi.fn(async () => state.branch),
    getChangedPaths: vi.fn(async () => ["workers/platform/src/api/health.ts"]),
    createBlob: vi.fn(async () => ({ sha: "2".repeat(40) })),
    createTree: vi.fn(async () => ({ sha: "3".repeat(40) })),
    createCommit: vi.fn(async () => ({ sha: "4".repeat(40) })),
    createBranch: vi.fn(async (_branch: string, sha: string) => {
      state.branch = { sha };
    }),
    createDraftPullRequest: vi.fn(async () => {
      state.pullRequest = { number: 21, url: "https://github.com/example/pull/21", draft: true };
      return state.pullRequest;
    }),
  };
  return { api, state };
}

function service(api: DraftPullRequestApi, writeEnabled: boolean) {
  return createRemediationService({
    api,
    repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
    baseBranch: "main",
    allowedPaths: ["workers/platform/src/api/health.ts"],
    limits: { maxFileBytes: 16_384, maxChangedLines: 80, maxLines: 400 },
    writeEnabled,
  });
}

describe("guarded remediation service", () => {
  it("returns an evidence-rich validated preview without external writes when disabled", async () => {
    const { api } = apiFixture();

    const result = await service(api, false).execute(proposal());

    expect(result).toMatchObject({
      status: "preview",
      writesPerformed: false,
      repository: "alexlopashev/cloudflare-agents-demo",
      branch: expect.stringMatching(/^regression-surgeon\/[0-9a-f]{16}$/),
      file: {
        path: "workers/platform/src/api/health.ts",
        additions: 2,
        deletions: 3,
        expectedBlobSha: blobSha,
      },
    });
    if (result.status !== "preview") throw new Error("Expected preview result");
    expect(result.body).toContain("scenario-trace-34");
    expect(result.body).toContain(regressionSha);
    expect(result.body).toContain("PR #19");
    expect(result.body).toContain("Risk");
    expect(result.body).toContain("Validation");
    expect(api.createBlob).not.toHaveBeenCalled();
    expect(api.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("fails closed on stale evidence, disallowed paths, and every size budget before writes", async () => {
    const { api } = apiFixture();
    vi.mocked(api.getBase).mockResolvedValue({ sha: "9".repeat(40), treeSha: "1".repeat(40) });
    await expect(service(api, true).execute(proposal())).rejects.toMatchObject({
      code: "stale-base",
    });

    vi.mocked(api.getBase).mockResolvedValue({ sha: regressionSha, treeSha: "1".repeat(40) });
    vi.mocked(api.getFile).mockResolvedValue({ blobSha: "8".repeat(40), content: original });
    await expect(service(api, true).execute(proposal())).rejects.toMatchObject({
      code: "stale-blob",
    });

    vi.mocked(api.getFile).mockResolvedValue({ blobSha, content: original });
    await expect(
      service(api, true).execute(proposal({ path: ".github/workflows/ci.yml" })),
    ).rejects.toMatchObject({ code: "not-allowed" });
    await expect(
      service(api, true).execute(proposal({ replacementContent: "x".repeat(16_385) })),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    await expect(
      createRemediationService({
        api,
        repository: api.repository,
        baseBranch: "main",
        allowedPaths: ["workers/platform/src/api/health.ts"],
        limits: { maxFileBytes: 16_384, maxChangedLines: 1, maxLines: 400 },
        writeEnabled: true,
      }).execute(proposal()),
    ).rejects.toMatchObject({ code: "limit-exceeded" });
    expect(api.createBlob).not.toHaveBeenCalled();
  });

  it("creates one draft PR and reuses it for the same incident", async () => {
    const { api } = apiFixture();
    const remediation = service(api, true);

    const created = await remediation.execute(proposal());
    const reused = await remediation.execute(proposal());

    expect(created).toMatchObject({ status: "created", number: 21, draft: true });
    expect(reused).toMatchObject({ status: "reused", number: 21, draft: true });
    expect(api.createBranch).toHaveBeenCalledOnce();
    expect(api.createDraftPullRequest).toHaveBeenCalledOnce();
  });

  it("returns a named recoverable state after an uncertain write and resumes without a duplicate branch", async () => {
    const { api, state } = apiFixture();
    vi.mocked(api.createDraftPullRequest).mockRejectedValueOnce(new Error("connection reset"));
    const remediation = service(api, true);

    const interrupted = await remediation.execute(proposal());
    expect(interrupted).toMatchObject({
      status: "recoverable",
      stage: "branch-created",
      branch: expect.stringMatching(/^regression-surgeon\//),
    });

    vi.mocked(api.createDraftPullRequest).mockImplementationOnce(async () => {
      state.pullRequest = { number: 21, url: "https://github.com/example/pull/21", draft: true };
      return state.pullRequest;
    });
    const resumed = await remediation.execute(proposal());

    expect(resumed).toMatchObject({ status: "created", number: 21 });
    expect(api.createBranch).toHaveBeenCalledOnce();
    expect(api.createDraftPullRequest).toHaveBeenCalledTimes(2);
  });

  it("tracks an uncertain branch response by deterministic name and reconciles on retry", async () => {
    const { api, state } = apiFixture();
    vi.mocked(api.createBranch).mockImplementationOnce(async (_branch, sha) => {
      state.branch = { sha };
      throw new Error("response lost after branch creation");
    });
    const remediation = service(api, true);

    await expect(remediation.execute(proposal())).resolves.toMatchObject({
      status: "recoverable",
      stage: "branch-write-uncertain",
      branch: expect.stringMatching(/^regression-surgeon\//),
    });
    await expect(remediation.execute(proposal())).resolves.toMatchObject({
      status: "created",
      number: 21,
    });
    expect(api.createBranch).toHaveBeenCalledOnce();
  });

  it("rejects recovery branches containing any change outside the one approved source file", async () => {
    const { api, state } = apiFixture();
    state.branch = { sha: "4".repeat(40) };
    vi.mocked(api.getChangedPaths).mockResolvedValue([
      "workers/platform/src/api/health.ts",
      ".github/workflows/ci.yml",
    ]);

    await expect(service(api, true).execute(proposal())).rejects.toMatchObject({
      code: "not-allowed",
    });
    expect(api.createDraftPullRequest).not.toHaveBeenCalled();
  });

  it("rejects mismatched adapters and malformed proposals before any network call", async () => {
    const { api } = apiFixture();
    expect(() =>
      createRemediationService({
        api: { ...api, repository: { owner: "attacker", repo: "other" } },
        repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
        baseBranch: "main",
        allowedPaths: ["workers/platform/src/api/health.ts"],
        limits: { maxFileBytes: 16_384, maxChangedLines: 80, maxLines: 400 },
        writeEnabled: true,
      }),
    ).toThrow(RemediationError);
    await expect(
      service(api, true).execute({ ...proposal(), unexpected: true } as RemediationProposal),
    ).rejects.toMatchObject({ code: "invalid-input" });
    await expect(
      service(api, true).execute(proposal({ expectedBaseSha: "8".repeat(40) })),
    ).rejects.toMatchObject({ code: "invalid-input" });
    expect(api.getBase).not.toHaveBeenCalled();
  });
});
