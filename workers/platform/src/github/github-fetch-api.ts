import { z } from "zod";

import { RepositoryConnectorError } from "./errors";
import { isSafeRepositoryPath } from "./path-policy";
import type { GitHubRepositoryApi } from "./repository-connector";

type Fetcher = (request: Request) => Promise<Response>;

export type GitHubFetchApiOptions = {
  fetcher?: Fetcher;
  repository: { owner: string; repo: string };
  maxResponseBytes: number;
  token?: string;
};

const repositorySchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
const immutableSha = z.string().regex(/^[0-9a-f]{40}$/i);

export class GitHubFetchApi implements GitHubRepositoryApi {
  readonly repository: { owner: string; repo: string };
  readonly maxResponseBytes: number;
  readonly #fetcher: Fetcher;
  readonly #owner: string;
  readonly #repo: string;
  readonly #maxResponseBytes: number;
  readonly #token: string | undefined;

  constructor(options: GitHubFetchApiOptions) {
    const repository = repositorySchema.safeParse(options.repository);
    if (
      !repository.success ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes <= 0
    ) {
      throw new RepositoryConnectorError("invalid-input", "GitHub API policy is invalid.");
    }
    if (
      options.token !== undefined &&
      (options.token.length === 0 || options.token.length > 4_096)
    ) {
      throw new RepositoryConnectorError("invalid-input", "GitHub token is invalid.");
    }
    this.#fetcher = options.fetcher ?? fetch;
    this.#owner = repository.data.owner;
    this.#repo = repository.data.repo;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#token = options.token;
    this.repository = { owner: this.#owner, repo: this.#repo };
    this.maxResponseBytes = this.#maxResponseBytes;
  }

  async getCommit(commitSha: string, pageSize: number): Promise<unknown> {
    return this.#request(
      `/commits/${this.#requireSha(commitSha)}?per_page=${this.#requirePageSize(pageSize)}`,
    );
  }

  async getPullRequestsForCommit(commitSha: string, pageSize: number): Promise<unknown> {
    return this.#request(
      `/commits/${this.#requireSha(commitSha)}/pulls?per_page=${this.#requirePageSize(pageSize)}`,
    );
  }

  async getFile(commitSha: string, path: string): Promise<unknown> {
    if (!isSafeRepositoryPath(path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    return this.#request(`/contents/${encodedPath}?ref=${this.#requireSha(commitSha)}`);
  }

  #requireSha(value: string): string {
    const result = immutableSha.safeParse(value);
    if (!result.success) {
      throw new RepositoryConnectorError(
        "invalid-input",
        "A full immutable commit SHA is required.",
      );
    }
    return result.data;
  }

  #requirePageSize(value: number): number {
    if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
      throw new RepositoryConnectorError("invalid-input", "GitHub page size is invalid.");
    }
    return value;
  }

  async #request(endpoint: string): Promise<unknown> {
    const url = new URL(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}${endpoint}`,
      "https://api.github.com",
    );
    const headers = new Headers({
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    });
    if (this.#token !== undefined) headers.set("authorization", `Bearer ${this.#token}`);

    let response: Response;
    try {
      response = await this.#fetcher(new Request(url, { headers }));
    } catch {
      throw new RepositoryConnectorError("unavailable", "GitHub request failed before a response.");
    }

    if (
      response.status === 429 ||
      (response.status === 403 && response.headers.get("x-ratelimit-remaining") === "0")
    ) {
      const reset = response.headers.get("x-ratelimit-reset");
      const retryAtEpochSeconds = reset === null ? undefined : Number.parseInt(reset, 10);
      const retryOptions =
        typeof retryAtEpochSeconds === "number" && Number.isSafeInteger(retryAtEpochSeconds)
          ? { retryAtEpochSeconds }
          : {};
      throw new RepositoryConnectorError("rate-limited", "GitHub rate limit exceeded.", {
        ...retryOptions,
      });
    }
    if (!response.ok) {
      throw new RepositoryConnectorError(
        "unavailable",
        `GitHub request failed with HTTP ${response.status}.`,
      );
    }

    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) {
        throw new RepositoryConnectorError(
          "malformed-response",
          "GitHub content length is invalid.",
        );
      }
      const parsedLength = Number.parseInt(declaredLength, 10);
      if (!Number.isSafeInteger(parsedLength)) {
        throw new RepositoryConnectorError(
          "malformed-response",
          "GitHub content length is invalid.",
        );
      }
      if (parsedLength > this.#maxResponseBytes) {
        throw new RepositoryConnectorError(
          "limit-exceeded",
          "GitHub response byte limit exceeded.",
        );
      }
    }

    const bytes = await this.#readBoundedBody(response);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new RepositoryConnectorError("malformed-response", "GitHub returned invalid UTF-8.");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw new RepositoryConnectorError("malformed-response", "GitHub returned invalid JSON.");
    }
  }

  async #readBoundedBody(response: Response): Promise<Uint8Array> {
    if (response.body === null) {
      throw new RepositoryConnectorError("malformed-response", "GitHub returned an empty body.");
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new RepositoryConnectorError("unavailable", "GitHub response stream failed.");
      }
      if (result.done) break;
      totalBytes += result.value.byteLength;
      if (totalBytes > this.#maxResponseBytes) {
        await reader.cancel();
        throw new RepositoryConnectorError(
          "limit-exceeded",
          "GitHub response byte limit exceeded.",
        );
      }
      chunks.push(result.value);
    }
    const output = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return output;
  }
}

export { RepositoryConnectorError } from "./errors";
