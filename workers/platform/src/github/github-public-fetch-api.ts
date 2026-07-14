import { z } from "zod";

import { RepositoryConnectorError } from "./errors";
import { isSafeRepositoryPath } from "./path-policy";
import type { GitHubRepositoryApi } from "./repository-connector";

type Fetcher = (request: Request) => Promise<Response>;

type GitHubPublicFetchApiOptions = {
  fetcher?: Fetcher;
  repository: { owner: string; repo: string };
  maxResponseBytes: number;
  provenance?: {
    pullRequestNumber: number;
    pullRequestBaseSha: string;
    pullRequestHeadSha: string;
    sourcePath: string;
  };
};

const repositorySchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
const immutableSha = z.string().regex(/^[0-9a-f]{40}$/i);

type ConfiguredProvenance = {
  sha: string;
  pullRequestHeadSha: string;
  files: {
    filename: string;
    status: "modified";
    additions: null;
    deletions: null;
    metadata: {
      status: "partial";
      unknowns: ["additions", "deletions", "patch"];
    };
  }[];
};

function malformed(label: string): RepositoryConnectorError {
  return new RepositoryConnectorError("malformed-response", `${label} did not match its contract.`);
}

export class GitHubPublicFetchApi implements GitHubRepositoryApi {
  readonly repository: { owner: string; repo: string };
  readonly maxResponseBytes: number;
  readonly #fetcher: Fetcher;
  readonly #owner: string;
  readonly #provenance:
    | {
        pullRequestNumber: number;
        pullRequestBaseSha: string;
        pullRequestHeadSha: string;
        sourcePath: string;
      }
    | undefined;
  readonly #provenanceRequests = new Map<string, Promise<ConfiguredProvenance>>();
  readonly #repo: string;

  constructor(options: GitHubPublicFetchApiOptions) {
    const repository = repositorySchema.safeParse(options.repository);
    const provenance = z
      .object({
        pullRequestNumber: z.number().int().positive(),
        pullRequestBaseSha: immutableSha,
        pullRequestHeadSha: immutableSha,
        sourcePath: z.string().min(1).max(512).refine(isSafeRepositoryPath),
      })
      .strict()
      .optional()
      .safeParse(options.provenance);
    if (
      !repository.success ||
      !provenance.success ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes <= 0
    ) {
      throw new RepositoryConnectorError("invalid-input", "GitHub public policy is invalid.");
    }
    this.#fetcher = options.fetcher ?? fetch;
    this.#owner = repository.data.owner;
    this.#repo = repository.data.repo;
    this.#provenance =
      provenance.data === undefined
        ? undefined
        : {
            ...provenance.data,
            pullRequestBaseSha: provenance.data.pullRequestBaseSha.toLowerCase(),
            pullRequestHeadSha: provenance.data.pullRequestHeadSha.toLowerCase(),
          };
    this.repository = { owner: this.#owner, repo: this.#repo };
    this.maxResponseBytes = options.maxResponseBytes;
  }

  async getCommit(commitSha: string, pageSize: number): Promise<unknown> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RepositoryConnectorError("invalid-input", "GitHub page size is invalid.");
    }
    const parsed = await this.#readConfiguredProvenance(commitSha);
    if (parsed.files.length > pageSize) {
      throw new RepositoryConnectorError("limit-exceeded", "Commit changed-file limit exceeded.");
    }
    const sourceFile = parsed.files[0];
    if (sourceFile === undefined) throw malformed("GitHub configured PR source");
    return {
      source: "configured-pr-source",
      sha: parsed.sha,
      html_url: `https://github.com/${this.#owner}/${this.#repo}/commit/${parsed.sha}`,
      metadata: {
        status: "partial",
        unknowns: ["message", "committed-at", "author-login"],
      },
      files: [sourceFile],
    };
  }

  async getPullRequestsForCommit(commitSha: string, pageSize: number): Promise<unknown> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RepositoryConnectorError("invalid-input", "GitHub page size is invalid.");
    }
    const parsed = await this.#readConfiguredProvenance(commitSha);
    const provenance = this.#requireProvenance();
    return [
      {
        source: "configured-pr-source",
        number: provenance.pullRequestNumber,
        html_url: `https://github.com/${this.#owner}/${this.#repo}/pull/${provenance.pullRequestNumber}`,
        head: { sha: parsed.pullRequestHeadSha },
      },
    ];
  }

  async getFile(commitSha: string, path: string): Promise<unknown> {
    const sha = this.#requireSha(commitSha);
    if (!isSafeRepositoryPath(path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    const bytes = await this.#readRawFile(sha, path);
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw malformed("GitHub public file");
    }
    return {
      source: "public-raw",
      type: "file",
      path,
      sha: await this.#gitBlobSha(bytes),
      size: bytes.byteLength,
      content,
    };
  }

  async getMainBranchHead(): Promise<{ sha: string }> {
    const url = new URL(
      `/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/commits/main.atom`,
      "https://github.com",
    );
    const bytes = await this.#requestBytes(url);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw malformed("GitHub public branch feed");
    }
    const firstEntry = /<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/.exec(text)?.[1];
    const commitSha =
      firstEntry === undefined
        ? undefined
        : /<id>\s*tag:github\.com,2008:Grit::Commit\/([0-9a-f]{40})\s*<\/id>/i.exec(
            firstEntry,
          )?.[1];
    const parsed = immutableSha.safeParse(commitSha);
    if (!parsed.success) throw malformed("GitHub public branch feed");
    return { sha: parsed.data.toLowerCase() };
  }

  async #readConfiguredProvenance(commitSha: string): Promise<ConfiguredProvenance> {
    const sha = this.#requireSha(commitSha);
    const existing = this.#provenanceRequests.get(sha);
    if (existing !== undefined) return existing;
    const request = this.#loadConfiguredProvenance(sha).catch((error: unknown) => {
      this.#provenanceRequests.delete(sha);
      throw error;
    });
    this.#provenanceRequests.set(sha, request);
    return request;
  }

  async #loadConfiguredProvenance(sha: string): Promise<ConfiguredProvenance> {
    const provenance = this.#requireProvenance();
    const [pullRequestBytes, baseBytes, headBytes, regressionBytes] = await Promise.all([
      this.#readPullRequestFile(provenance.pullRequestNumber, provenance.sourcePath),
      this.#readRawFile(provenance.pullRequestBaseSha, provenance.sourcePath),
      this.#readRawFile(provenance.pullRequestHeadSha, provenance.sourcePath),
      this.#readRawFile(sha, provenance.sourcePath),
    ]);
    if (
      !this.#sameBytes(pullRequestBytes, headBytes) ||
      !this.#sameBytes(headBytes, regressionBytes) ||
      this.#sameBytes(baseBytes, headBytes)
    ) {
      throw malformed("GitHub configured PR source equality");
    }
    const [pullRequestBlobSha, baseBlobSha, headBlobSha, regressionBlobSha] = await Promise.all([
      this.#gitBlobSha(pullRequestBytes),
      this.#gitBlobSha(baseBytes),
      this.#gitBlobSha(headBytes),
      this.#gitBlobSha(regressionBytes),
    ]);
    if (
      pullRequestBlobSha !== headBlobSha ||
      headBlobSha !== regressionBlobSha ||
      baseBlobSha === headBlobSha
    ) {
      throw malformed("GitHub configured PR source identity");
    }
    return {
      sha,
      pullRequestHeadSha: provenance.pullRequestHeadSha,
      files: [
        {
          filename: provenance.sourcePath,
          status: "modified",
          additions: null,
          deletions: null,
          metadata: {
            status: "partial",
            unknowns: ["additions", "deletions", "patch"],
          },
        },
      ],
    };
  }

  #requireProvenance() {
    if (this.#provenance === undefined) {
      throw new RepositoryConnectorError(
        "invalid-input",
        "GitHub configured PR provenance is required for release inspection.",
      );
    }
    return this.#provenance;
  }

  async #readRawFile(sha: string, path: string): Promise<Uint8Array> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/${sha}/${encodedPath}`,
      "https://raw.githubusercontent.com",
    );
    return this.#requestBytes(url);
  }

  async #readPullRequestFile(pullRequestNumber: number, path: string): Promise<Uint8Array> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/refs/pull/${pullRequestNumber}/head/${encodedPath}`,
      "https://raw.githubusercontent.com",
    );
    return this.#requestBytes(url);
  }

  #sameBytes(left: Uint8Array, right: Uint8Array): boolean {
    return (
      left.byteLength === right.byteLength && left.every((byte, index) => byte === right[index])
    );
  }

  #requireSha(value: string): string {
    const parsed = immutableSha.safeParse(value);
    if (!parsed.success) {
      throw new RepositoryConnectorError(
        "invalid-input",
        "A full immutable commit SHA is required.",
      );
    }
    return parsed.data.toLowerCase();
  }

  async #requestBytes(url: URL): Promise<Uint8Array> {
    let response: Response;
    try {
      response = await this.#fetcher(
        new Request(url, {
          headers: {
            accept: "text/plain",
            range: `bytes=0-${this.maxResponseBytes}`,
            "user-agent": "Regression-Surgeon",
          },
        }),
      );
    } catch {
      throw new RepositoryConnectorError("unavailable", "GitHub public request is unavailable.");
    }
    if (!response.ok) {
      throw new RepositoryConnectorError(
        response.status === 404 ? "not-found" : "unavailable",
        `GitHub public request failed with HTTP ${response.status}.`,
      );
    }
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      const length = Number.parseInt(declared, 10);
      if (!/^(?:0|[1-9]\d*)$/.test(declared) || !Number.isSafeInteger(length)) {
        throw malformed("GitHub public content length");
      }
      if (length > this.maxResponseBytes) {
        throw new RepositoryConnectorError(
          "limit-exceeded",
          "GitHub public response byte limit exceeded.",
        );
      }
    }
    const contentRange = response.headers.get("content-range");
    const total = contentRange === null ? undefined : /\/([1-9]\d*)$/.exec(contentRange)?.[1];
    if (total !== undefined && Number.parseInt(total, 10) > this.maxResponseBytes) {
      throw new RepositoryConnectorError(
        "limit-exceeded",
        "GitHub public response byte limit exceeded.",
      );
    }
    if (response.body === null) throw malformed("GitHub public response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new RepositoryConnectorError(
          "unavailable",
          "GitHub public response stream is unavailable.",
        );
      }
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > this.maxResponseBytes) {
        await reader.cancel();
        throw new RepositoryConnectorError(
          "limit-exceeded",
          "GitHub public response byte limit exceeded.",
        );
      }
      chunks.push(result.value);
    }
    const bytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }

  async #gitBlobSha(bytes: Uint8Array): Promise<string> {
    const prefix = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
    const input = new Uint8Array(prefix.byteLength + bytes.byteLength);
    input.set(prefix);
    input.set(bytes, prefix.byteLength);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", input));
    return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
}

export type { GitHubPublicFetchApiOptions };
