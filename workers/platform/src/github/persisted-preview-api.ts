import {
  configuredSourceEvidencePolicy,
  gitBlobSha,
  parseReleasePreviewEvidence,
  parseReleaseSourceEvidence,
  type ReleasePreviewEvidence,
  type ReleaseSourceEvidence,
} from "../../../../packages/contracts/src/source-evidence";
import type { RemediationReadApi } from "../remediation/service";

import { RepositoryConnectorError } from "./errors";

type PersistedPreviewStore = {
  getReleaseSourceEvidence(releaseId: string): Promise<unknown>;
  getReleasePreviewEvidence(releaseId: string, baseSha: string): Promise<unknown>;
};

type PersistedPreviewApiOptions = {
  repository: { owner: string; repo: string };
  releaseId: string;
  baseSha: string;
  store: PersistedPreviewStore;
};

function malformed(): RepositoryConnectorError {
  return new RepositoryConnectorError(
    "malformed-response",
    "Persisted preview evidence did not match its immutable source receipt.",
  );
}

export class PersistedPreviewApi implements RemediationReadApi {
  readonly repository: { owner: string; repo: string };
  readonly #releaseId: string;
  readonly #baseSha: string;
  readonly #store: PersistedPreviewStore;
  #evidence: { source: ReleaseSourceEvidence; preview: ReleasePreviewEvidence } | undefined;

  constructor(options: PersistedPreviewApiOptions) {
    const configured = configuredSourceEvidencePolicy.repository;
    if (
      options.repository.owner !== configured.owner ||
      options.repository.repo !== configured.repo ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(options.releaseId) ||
      !/^[0-9a-f]{40}$/.test(options.baseSha)
    ) {
      throw new RepositoryConnectorError("invalid-input", "Persisted preview policy is invalid.");
    }
    this.repository = { ...options.repository };
    this.#releaseId = options.releaseId;
    this.#baseSha = options.baseSha;
    this.#store = options.store;
  }

  async #load() {
    if (this.#evidence !== undefined) return this.#evidence;
    const [rawSource, rawPreview] = await Promise.all([
      this.#store.getReleaseSourceEvidence(this.#releaseId),
      this.#store.getReleasePreviewEvidence(this.#releaseId, this.#baseSha),
    ]);
    let source: ReleaseSourceEvidence;
    let preview: ReleasePreviewEvidence;
    try {
      source = parseReleaseSourceEvidence(rawSource);
      preview = parseReleasePreviewEvidence(rawPreview);
    } catch {
      throw malformed();
    }
    if (
      source.releaseId !== this.#releaseId ||
      preview.releaseId !== this.#releaseId ||
      preview.baseSha !== this.#baseSha ||
      source.sourcePath !== preview.sourcePath ||
      source.blobSha !== preview.blobSha ||
      source.byteLength !== preview.byteLength ||
      source.content !== preview.content ||
      (await gitBlobSha(source.content)) !== source.blobSha ||
      (await gitBlobSha(preview.content)) !== preview.blobSha
    ) {
      throw malformed();
    }
    this.#evidence = { source, preview };
    return this.#evidence;
  }

  async getBase(branch: string) {
    if (branch !== "main") {
      throw new RepositoryConnectorError(
        "invalid-input",
        "Only the configured main branch can be previewed.",
      );
    }
    return { sha: (await this.#load()).preview.baseSha };
  }

  async getFile(ref: string, path: string) {
    const evidence = await this.#load();
    if (path !== evidence.source.sourcePath) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    if (ref === evidence.source.commitSha) {
      return { blobSha: evidence.source.blobSha, content: evidence.source.content };
    }
    if (ref === evidence.preview.baseSha) {
      return { blobSha: evidence.preview.blobSha, content: evidence.preview.content };
    }
    throw new RepositoryConnectorError(
      "not-allowed",
      "Preview source is limited to the configured immutable refs.",
    );
  }
}

export type { PersistedPreviewApiOptions, PersistedPreviewStore };
