import { describe, expect, it, vi } from "vitest";

import { PersistedPreviewApi } from "../../workers/platform/src/github/persisted-preview-api";

const releaseId = "regression-sequential";
const commitSha = "d591869a8ef995f1835ef80152f4de085b10255b";
const baseSha = "a".repeat(40);
const sourcePath = "workers/platform/src/api/health.ts";
const content = "sequential\n";
const blobSha = "58477bb417f47e0edf26725e9638e781b69f124c";

function fixture(previewOverrides: Record<string, unknown> = {}) {
  const store = {
    getReleaseSourceEvidence: vi.fn(async () => ({
      releaseId,
      commitSha,
      commitSubject: "perf: serialize health checks (#19)",
      committedAt: "2026-07-12T01:42:21.000Z",
      pullRequestNumber: 19,
      pullRequestHeadSha: "9af361e5a9420323b2c86f2670e3bf812ac58620",
      sourcePath,
      blobSha,
      byteLength: 11,
      content,
    })),
    getReleasePreviewEvidence: vi.fn(async () => ({
      releaseId,
      baseSha,
      sourcePath,
      blobSha,
      byteLength: 11,
      content,
      ...previewOverrides,
    })),
  };
  return new PersistedPreviewApi({
    repository: { owner: "alexlopashev", repo: "cloudflare-agents-demo" },
    releaseId,
    baseSha,
    store,
  });
}

describe("PersistedPreviewApi", () => {
  it("validates an advanced base only from the configured immutable source receipts", async () => {
    const api = fixture();

    await expect(api.getBase("main")).resolves.toEqual({ sha: baseSha });
    await expect(api.getFile(commitSha, sourcePath)).resolves.toEqual({ blobSha, content });
    await expect(api.getFile(baseSha, sourcePath)).resolves.toEqual({ blobSha, content });
  });

  it("fails closed on mismatched evidence without exposing write capabilities", async () => {
    await expect(fixture({ content: "changed\n" }).getBase("main")).rejects.toMatchObject({
      code: "malformed-response",
    });
    const api = fixture();
    await expect(api.getBase("release")).rejects.toMatchObject({ code: "invalid-input" });
    await expect(api.getFile("b".repeat(40), sourcePath)).rejects.toMatchObject({
      code: "not-allowed",
    });
    await expect(api.getFile(commitSha, "README.md")).rejects.toMatchObject({
      code: "not-allowed",
    });
    expect("createBlob" in api).toBe(false);
    expect("createBranch" in api).toBe(false);
    expect("createDraftPullRequest" in api).toBe(false);
  });
});
