import { z } from "zod";

import { RepositoryConnectorError } from "./errors";
import { isSafeRepositoryPath } from "./path-policy";

const immutableSha = z.string().regex(/^[0-9a-f]{40}$/i);
const timestamp = z.iso.datetime({ offset: true });
const releaseEvidence = z.object({
  versionId: z.string().min(1).max(128),
  commitSha: immutableSha,
});
const commitFile = z.object({
  filename: z.string().min(1).max(512).refine(isSafeRepositoryPath),
  status: z.enum(["added", "modified", "removed", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  patch: z.string().optional(),
});
const commitResponse = z.object({
  sha: immutableSha,
  html_url: z.url(),
  commit: z.object({
    message: z.string().min(1).max(16_000),
    committer: z.object({ date: timestamp }),
  }),
  author: z.object({ login: z.string().min(1).max(128) }).nullable(),
  files: z.array(commitFile),
});
const pullRequestResponse = z.object({
  number: z.number().int().positive(),
  title: z.string().min(1).max(1_024),
  html_url: z.url(),
  state: z.enum(["open", "closed"]),
  merged_at: timestamp.nullable(),
  user: z.object({ login: z.string().min(1).max(128) }).nullable(),
  base: z.object({ sha: immutableSha }),
  head: z.object({ sha: immutableSha }),
});
const publicPatchPullRequestResponse = z.object({
  source: z.literal("public-patch"),
  number: z.number().int().positive(),
  commitSubject: z.string().min(1).max(1_024),
  html_url: z.url(),
  head: z.object({ sha: immutableSha }),
});
const associatedPullRequestResponse = z.union([
  pullRequestResponse,
  publicPatchPullRequestResponse,
]);

export interface GitHubRepositoryApi {
  readonly repository: { owner: string; repo: string };
  readonly maxResponseBytes: number;
  getCommit(commitSha: string, pageSize: number): Promise<unknown>;
  getPullRequestsForCommit(commitSha: string, pageSize: number): Promise<unknown>;
  getFile(commitSha: string, path: string): Promise<unknown>;
}

export interface ReleaseSource {
  resolve(versionId: string): Promise<unknown>;
}

export type RepositoryConnectorLimits = {
  maxApiResponseBytes: number;
  maxChangedFiles: number;
  maxFiles: number;
  maxFileBytes: number;
  maxPatchBytes: number;
  maxTotalBytes: number;
};

export type RepositoryConnectorOptions = {
  api: GitHubRepositoryApi;
  releases: ReleaseSource;
  repository: { owner: string; repo: string };
  allowedPathPrefixes: readonly string[];
  limits: RepositoryConnectorLimits;
};

export type PullRequestEvidence =
  | {
      status: "found";
      number: number;
      title: string;
      authorLogin: string | null;
      baseSha: string;
      headSha: string;
      mergedAt: string | null;
      url: string;
    }
  | {
      status: "found";
      number: number;
      title: null;
      authorLogin: null;
      headSha: string;
      url: string;
      metadata: {
        status: "partial";
        unknowns: readonly ["title", "author-login", "base-sha", "merged-at"];
      };
    }
  | { status: "unknown"; reason: "not-found" | "ambiguous" };

const positiveLimit = z.number().int().positive();
const repositoryOptions = z
  .object({
    repository: z
      .object({
        owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
        repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
      })
      .strict(),
    allowedPathPrefixes: z
      .array(z.string().regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*\/$/))
      .min(1)
      .max(16),
    limits: z
      .object({
        maxApiResponseBytes: positiveLimit,
        maxChangedFiles: positiveLimit.max(99),
        maxFiles: positiveLimit,
        maxFileBytes: positiveLimit,
        maxPatchBytes: positiveLimit,
        maxTotalBytes: positiveLimit,
      })
      .strict(),
  })
  .strict();

function malformed(label: string): RepositoryConnectorError {
  return new RepositoryConnectorError("malformed-response", `${label} did not match its contract.`);
}

function parseExternal<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw malformed(label);
  return result.data;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

export class RepositoryConnector {
  readonly #api: GitHubRepositoryApi;
  readonly #releases: ReleaseSource;
  readonly #allowedPathPrefixes: readonly string[];
  readonly #limits: RepositoryConnectorLimits;
  readonly #repository: { owner: string; repo: string };

  constructor(options: RepositoryConnectorOptions) {
    const policy = repositoryOptions.safeParse({
      repository: options.repository,
      allowedPathPrefixes: options.allowedPathPrefixes,
      limits: options.limits,
    });
    if (!policy.success) {
      throw new RepositoryConnectorError("invalid-input", "Repository policy is invalid.");
    }
    this.#api = options.api;
    this.#releases = options.releases;
    this.#allowedPathPrefixes = policy.data.allowedPathPrefixes;
    this.#limits = policy.data.limits;
    this.#repository = policy.data.repository;
    if (
      options.api.repository.owner !== policy.data.repository.owner ||
      options.api.repository.repo !== policy.data.repository.repo ||
      !Number.isSafeInteger(options.api.maxResponseBytes) ||
      options.api.maxResponseBytes <= 0 ||
      options.api.maxResponseBytes > policy.data.limits.maxApiResponseBytes
    ) {
      throw new RepositoryConnectorError(
        "invalid-input",
        "GitHub API adapter does not match the repository policy.",
      );
    }
  }

  async inspectRelease(versionId: string) {
    const requestedVersion = z.string().min(1).max(128).safeParse(versionId);
    if (!requestedVersion.success) {
      throw new RepositoryConnectorError("invalid-input", "Release version is invalid.");
    }

    let rawRelease: unknown;
    try {
      rawRelease = await this.#releases.resolve(versionId);
    } catch (error) {
      if (error instanceof RepositoryConnectorError) throw error;
      throw new RepositoryConnectorError("unavailable", "Release evidence is unavailable.");
    }
    const release = parseExternal(releaseEvidence, rawRelease, "Release evidence");
    if (release.versionId !== versionId) throw malformed("Release evidence");

    const [rawCommit, rawPullRequests] = await Promise.all([
      this.#requestApi("GitHub commit", () =>
        this.#api.getCommit(release.commitSha, this.#limits.maxChangedFiles + 1),
      ),
      this.#requestApi("GitHub pull request", () =>
        this.#api.getPullRequestsForCommit(release.commitSha, 11),
      ),
    ]);
    const commit = parseExternal(commitResponse, rawCommit, "GitHub commit response");
    if (commit.sha.toLowerCase() !== release.commitSha.toLowerCase()) {
      throw malformed("GitHub commit response");
    }
    if (!this.#isEvidenceUrl(commit.html_url, "commit", commit.sha)) {
      throw malformed("GitHub commit response");
    }
    if (commit.files.length > this.#limits.maxChangedFiles) {
      throw new RepositoryConnectorError("limit-exceeded", "Commit changed-file limit exceeded.");
    }
    const patchBytes = commit.files.reduce(
      (total, file) => total + byteLength(file.patch ?? ""),
      0,
    );
    if (patchBytes > this.#limits.maxPatchBytes) {
      throw new RepositoryConnectorError("limit-exceeded", "Commit patch byte limit exceeded.");
    }

    const pullRequests = parseExternal(
      z.array(associatedPullRequestResponse).max(11),
      rawPullRequests,
      "GitHub pull request response",
    );
    if (pullRequests.length > 10) {
      throw new RepositoryConnectorError(
        "limit-exceeded",
        "Associated pull request result limit exceeded.",
      );
    }
    if (
      pullRequests.some(
        (pullRequest) =>
          !this.#isEvidenceUrl(pullRequest.html_url, "pull", String(pullRequest.number)),
      )
    ) {
      throw malformed("GitHub pull request response");
    }
    let pullRequest: PullRequestEvidence;
    if (pullRequests.length === 0) {
      pullRequest = { status: "unknown", reason: "not-found" };
    } else if (pullRequests.length > 1) {
      pullRequest = { status: "unknown", reason: "ambiguous" };
    } else {
      const onlyPullRequest = pullRequests[0];
      if (onlyPullRequest === undefined) throw malformed("GitHub pull request response");
      pullRequest = this.#toPullRequestEvidence(onlyPullRequest);
    }

    return {
      release,
      commit: {
        sha: commit.sha,
        message: commit.commit.message,
        committedAt: commit.commit.committer.date,
        authorLogin: commit.author?.login ?? null,
        url: commit.html_url,
        changes: commit.files
          .filter((file) => this.#isAllowedPath(file.filename))
          .map((file) => ({
            path: file.filename,
            status: file.status,
            additions: file.additions,
            deletions: file.deletions,
            ...(file.patch === undefined ? {} : { patch: file.patch }),
          })),
      },
      pullRequest,
    };
  }

  async readFiles(request: { commitSha: string; paths: readonly string[] }) {
    const sha = immutableSha.safeParse(request.commitSha);
    if (!sha.success) {
      throw new RepositoryConnectorError(
        "invalid-input",
        "A full immutable commit SHA is required.",
      );
    }
    if (request.paths.length === 0 || request.paths.length > this.#limits.maxFiles) {
      throw new RepositoryConnectorError("limit-exceeded", "Repository file-count limit exceeded.");
    }

    const paths = request.paths.map((path) => this.#requireAllowedPath(path));
    if (new Set(paths).size !== paths.length) {
      throw new RepositoryConnectorError(
        "invalid-input",
        "Duplicate repository paths are not allowed.",
      );
    }

    const files = [];
    let totalBytes = 0;
    for (const path of paths) {
      const rawFile = await this.#requestApi("GitHub file", () =>
        this.#api.getFile(sha.data, path),
      );
      const file = this.#parseFile(rawFile, path);
      if (file.bytes.byteLength > this.#limits.maxFileBytes) {
        throw new RepositoryConnectorError(
          "limit-exceeded",
          `Repository file byte limit exceeded: ${path}.`,
        );
      }
      totalBytes += file.bytes.byteLength;
      if (totalBytes > this.#limits.maxTotalBytes) {
        throw new RepositoryConnectorError(
          "limit-exceeded",
          "Repository aggregate byte limit exceeded.",
        );
      }
      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
      } catch {
        throw malformed("GitHub file response");
      }
      files.push({
        path,
        blobSha: file.blobSha,
        byteLength: file.bytes.byteLength,
        content,
      });
    }
    return files;
  }

  #toPullRequestEvidence(
    pullRequest: z.infer<typeof associatedPullRequestResponse>,
  ): PullRequestEvidence {
    if (!("base" in pullRequest)) {
      return {
        status: "found",
        number: pullRequest.number,
        title: null,
        authorLogin: null,
        headSha: pullRequest.head.sha,
        url: pullRequest.html_url,
        metadata: {
          status: "partial",
          unknowns: ["title", "author-login", "base-sha", "merged-at"],
        },
      };
    }
    return {
      status: "found",
      number: pullRequest.number,
      title: pullRequest.title,
      authorLogin: pullRequest.user?.login ?? null,
      baseSha: pullRequest.base.sha,
      headSha: pullRequest.head.sha,
      mergedAt: pullRequest.merged_at,
      url: pullRequest.html_url,
    };
  }

  #parseFile(rawFile: unknown, expectedPath: string) {
    const publicFile = z
      .object({
        source: z.literal("public-raw"),
        type: z.literal("file"),
        path: z.string().min(1).max(512),
        sha: immutableSha,
        size: z.number().int().nonnegative(),
        content: z.string(),
      })
      .safeParse(rawFile);
    if (publicFile.success) {
      if (publicFile.data.path !== expectedPath) throw malformed("GitHub public file response");
      const bytes = new TextEncoder().encode(publicFile.data.content);
      if (bytes.byteLength !== publicFile.data.size) {
        throw malformed("GitHub public file response");
      }
      return { blobSha: publicFile.data.sha, bytes };
    }
    const encodedByteLimit = Math.ceil(this.#limits.maxFileBytes / 3) * 4;
    const lineBreakAllowance = Math.ceil(encodedByteLimit / 60) + 2;
    const schema = z.object({
      type: z.literal("file"),
      path: z.string().min(1).max(512),
      sha: immutableSha,
      size: z.number().int().nonnegative(),
      encoding: z.literal("base64"),
      content: z.string().max(encodedByteLimit + lineBreakAllowance),
    });
    const file = parseExternal(schema, rawFile, "GitHub file response");
    if (file.path !== expectedPath) throw malformed("GitHub file response");

    const encoded = file.content.replaceAll(/\s/g, "");
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw malformed("GitHub file response");
    }
    let binary: string;
    try {
      binary = atob(encoded);
    } catch {
      throw malformed("GitHub file response");
    }
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    if (bytes.byteLength !== file.size) throw malformed("GitHub file response");
    return { blobSha: file.sha, bytes };
  }

  #requireAllowedPath(path: string): string {
    if (!isSafeRepositoryPath(path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    if (!this.#isAllowedPath(path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowlisted.");
    }
    return path;
  }

  #isAllowedPath(path: string): boolean {
    return this.#allowedPathPrefixes.some((prefix) => path.startsWith(prefix));
  }

  #isEvidenceUrl(value: string, kind: "commit" | "pull", identifier: string): boolean {
    const url = new URL(value);
    const segments = url.pathname.split("/").filter(Boolean);
    return (
      url.protocol === "https:" &&
      url.hostname === "github.com" &&
      url.search === "" &&
      url.hash === "" &&
      segments.length === 4 &&
      segments[0]?.toLowerCase() === this.#repository.owner.toLowerCase() &&
      segments[1]?.toLowerCase() === this.#repository.repo.toLowerCase() &&
      segments[2] === kind &&
      segments[3]?.toLowerCase() === identifier.toLowerCase()
    );
  }

  async #requestApi(label: string, operation: () => Promise<unknown>): Promise<unknown> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof RepositoryConnectorError) throw error;
      throw new RepositoryConnectorError("unavailable", `${label} request is unavailable.`);
    }
  }
}

export { RepositoryConnectorError } from "./errors";
