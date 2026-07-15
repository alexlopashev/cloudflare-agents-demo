import { z } from "zod";

import type { RemediationReadApi } from "../remediation/service";
import { RepositoryConnectorError } from "./errors";
import { GitHubPublicFetchApi } from "./github-public-fetch-api";
import { isSafeRepositoryPath } from "./path-policy";

type GitHubPublicPreviewApiOptions = {
  fetcher?: (request: Request) => Promise<Response>;
  repository: { owner: string; repo: string };
  allowedPaths: readonly string[];
  maxResponseBytes: number;
};

const publicFileResponse = z
  .object({
    source: z.literal("public-raw"),
    type: z.literal("file"),
    path: z.string(),
    sha: z.string().regex(/^[0-9a-f]{40}$/),
    content: z.string(),
  })
  .passthrough();

export class GitHubPublicPreviewApi implements RemediationReadApi {
  readonly repository: { owner: string; repo: string };
  readonly #allowedPaths: ReadonlySet<string>;
  readonly #publicApi: GitHubPublicFetchApi;

  constructor(options: GitHubPublicPreviewApiOptions) {
    if (
      options.allowedPaths.length < 1 ||
      options.allowedPaths.length > 16 ||
      options.allowedPaths.some((path) => !isSafeRepositoryPath(path)) ||
      new Set(options.allowedPaths).size !== options.allowedPaths.length
    ) {
      throw new RepositoryConnectorError(
        "invalid-input",
        "GitHub public preview policy is invalid.",
      );
    }
    this.#publicApi = new GitHubPublicFetchApi({
      repository: options.repository,
      maxResponseBytes: options.maxResponseBytes,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    });
    this.repository = this.#publicApi.repository;
    this.#allowedPaths = new Set(options.allowedPaths);
  }

  async getBase(branch: string) {
    if (branch !== "main") {
      throw new RepositoryConnectorError(
        "invalid-input",
        "Only the configured main branch can be previewed.",
      );
    }
    return this.#publicApi.getMainBranchHead();
  }

  async getFile(ref: string, path: string) {
    if (!this.#allowedPaths.has(path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    const result = publicFileResponse.safeParse(await this.#publicApi.getFile(ref, path));
    if (!result.success || result.data.path !== path) {
      throw new RepositoryConnectorError(
        "malformed-response",
        "GitHub public file did not match its contract.",
      );
    }
    return { blobSha: result.data.sha, content: result.data.content };
  }
}

export type { GitHubPublicPreviewApiOptions };
