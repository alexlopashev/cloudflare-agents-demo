import { describe, expect, it, vi } from "vitest";

import type { ReleaseSourceEvidence } from "../../packages/contracts/src/source-evidence";
import { PersistedSourceRepository } from "../../workers/platform/src/github/persisted-source-repository";

const commitSha = "d591869a8ef995f1835ef80152f4de085b10255b";
const sourcePath = "workers/platform/src/api/health.ts";
const record = {
  releaseId: "regression-sequential",
  commitSha,
  commitSubject: "perf: serialize health checks to limit pressure (#19)",
  committedAt: "2026-07-12T01:42:21.000Z",
  pullRequestNumber: 19,
  pullRequestHeadSha: "9af361e5a9420323b2c86f2670e3bf812ac58620",
  sourcePath,
  blobSha: "58477bb417f47e0edf26725e9638e781b69f124c",
  byteLength: 11,
  content: "sequential\n",
} as const;

function repository(overrides: Partial<ReleaseSourceEvidence> = {}) {
  const evidence = { ...record, ...overrides };
  const store = {
    getReleaseAttribution: vi.fn(async () => ({
      versionId: evidence.releaseId,
      commitSha: evidence.commitSha,
    })),
    getReleaseSourceEvidence: vi.fn(async () => evidence),
  };
  return { repository: new PersistedSourceRepository({ store }), store };
}

describe("PersistedSourceRepository", () => {
  it("returns only the configured immutable release, PR, and source receipt", async () => {
    const { repository: persisted } = repository();

    await expect(persisted.inspectRelease(record.releaseId)).resolves.toEqual({
      release: { versionId: record.releaseId, commitSha },
      commit: {
        sha: commitSha,
        message: record.commitSubject,
        committedAt: record.committedAt,
        authorLogin: null,
        url: `https://github.com/alexlopashev/cloudflare-agents-demo/commit/${commitSha}`,
        changes: [
          {
            path: sourcePath,
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
        number: 19,
        title: null,
        authorLogin: null,
        headSha: record.pullRequestHeadSha,
        url: "https://github.com/alexlopashev/cloudflare-agents-demo/pull/19",
        metadata: {
          status: "partial",
          unknowns: ["title", "author-login", "base-sha", "merged-at"],
        },
      },
    });
    await expect(persisted.readFiles({ commitSha, paths: [sourcePath] })).resolves.toEqual([
      {
        path: sourcePath,
        blobSha: record.blobSha,
        byteLength: 11,
        content: "sequential\n",
      },
    ]);
  });

  it("fails closed for a mismatched release, source blob, SHA, or path", async () => {
    await expect(
      repository({ content: "different\n" }).repository.inspectRelease(record.releaseId),
    ).rejects.toMatchObject({
      code: "malformed-response",
    });
    await expect(repository().repository.inspectRelease("other-release")).rejects.toMatchObject({
      code: "malformed-response",
    });
    await expect(
      repository().repository.readFiles({ commitSha: "1".repeat(40), paths: [sourcePath] }),
    ).rejects.toMatchObject({ code: "not-allowed" });
    await expect(
      repository().repository.readFiles({
        commitSha,
        paths: ["workers/platform/src/api/other.ts"],
      }),
    ).rejects.toMatchObject({ code: "not-allowed" });
  });
});
