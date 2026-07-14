import {
  configuredSourceEvidencePolicy,
  parseReleaseSourceEvidence,
  type ReleaseSourceEvidence,
} from "../../../../packages/contracts/src/source-evidence";

import { RepositoryConnectorError } from "./errors";

type PersistedSourceStore = {
  getReleaseAttribution(releaseId: string): Promise<{
    versionId: string;
    commitSha: string;
  } | null>;
  getReleaseSourceEvidence(releaseId: string): Promise<unknown>;
};

type PersistedSourceRepositoryOptions = {
  store: PersistedSourceStore;
  releaseId?: string;
};

function malformed(message: string): RepositoryConnectorError {
  return new RepositoryConnectorError("malformed-response", message);
}

async function gitBlobSha(content: string): Promise<string> {
  const source = new TextEncoder().encode(content);
  const header = new TextEncoder().encode(`blob ${source.byteLength}\0`);
  const input = new Uint8Array(header.byteLength + source.byteLength);
  input.set(header);
  input.set(source, header.byteLength);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
  return [...digest].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class PersistedSourceRepository {
  readonly #store: PersistedSourceStore;
  readonly #configuredReleaseId: string | undefined;
  #validatedEvidence: ReleaseSourceEvidence | undefined;

  constructor(options: PersistedSourceRepositoryOptions) {
    this.#store = options.store;
    this.#configuredReleaseId = options.releaseId;
  }

  async #loadEvidence(releaseId: string): Promise<ReleaseSourceEvidence> {
    const [rawRelease, rawEvidence] = await Promise.all([
      this.#store.getReleaseAttribution(releaseId),
      this.#store.getReleaseSourceEvidence(releaseId),
    ]);
    let evidence: ReleaseSourceEvidence;
    try {
      evidence = parseReleaseSourceEvidence(rawEvidence);
    } catch {
      throw malformed("Persisted source evidence did not match its configured contract.");
    }
    if (
      rawRelease === null ||
      rawRelease.versionId !== releaseId ||
      rawRelease.commitSha !== evidence.commitSha ||
      evidence.releaseId !== releaseId ||
      (await gitBlobSha(evidence.content)) !== evidence.blobSha
    ) {
      throw malformed("Persisted source evidence did not match its immutable release or blob.");
    }
    this.#validatedEvidence = evidence;
    return evidence;
  }

  async inspectRelease(versionId: string) {
    if (this.#configuredReleaseId !== undefined && versionId !== this.#configuredReleaseId) {
      throw malformed("Requested release did not match the configured source receipt.");
    }
    const evidence = await this.#loadEvidence(versionId);
    const { owner, repo } = configuredSourceEvidencePolicy.repository;
    return {
      release: { versionId: evidence.releaseId, commitSha: evidence.commitSha },
      commit: {
        sha: evidence.commitSha,
        message: evidence.commitSubject,
        committedAt: evidence.committedAt,
        authorLogin: null,
        url: `https://github.com/${owner}/${repo}/commit/${evidence.commitSha}`,
        changes: [
          {
            path: evidence.sourcePath,
            status: "modified" as const,
            additions: null,
            deletions: null,
            metadata: {
              status: "partial" as const,
              unknowns: ["additions", "deletions", "patch"] as const,
            },
          },
        ],
      },
      pullRequest: {
        status: "found" as const,
        number: evidence.pullRequestNumber,
        title: null,
        authorLogin: null,
        headSha: evidence.pullRequestHeadSha,
        url: `https://github.com/${owner}/${repo}/pull/${evidence.pullRequestNumber}`,
        metadata: {
          status: "partial" as const,
          unknowns: ["title", "author-login", "base-sha", "merged-at"] as const,
        },
      },
    };
  }

  async readFiles(input: { commitSha: string; paths: readonly string[] }) {
    const evidence =
      this.#validatedEvidence ??
      (this.#configuredReleaseId === undefined
        ? undefined
        : await this.#loadEvidence(this.#configuredReleaseId));
    if (
      evidence === undefined ||
      input.commitSha !== evidence.commitSha ||
      input.paths.length !== 1 ||
      input.paths[0] !== evidence.sourcePath
    ) {
      throw new RepositoryConnectorError(
        "not-allowed",
        "Source read is limited to the configured immutable receipt.",
      );
    }
    return [
      {
        path: evidence.sourcePath,
        blobSha: evidence.blobSha,
        byteLength: evidence.byteLength,
        content: evidence.content,
      },
    ];
  }
}

export type { PersistedSourceRepositoryOptions, PersistedSourceStore };
