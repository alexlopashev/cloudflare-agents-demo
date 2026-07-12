import { z } from "zod";

import type { DraftPullRequestApi } from "../remediation/service";
import { RepositoryConnectorError } from "./errors";
import { isSafeRepositoryPath } from "./path-policy";

type Fetcher = (request: Request) => Promise<Response>;

type GitHubDraftPrApiOptions = {
  fetcher?: Fetcher;
  repository: { owner: string; repo: string };
  allowedPaths: readonly string[];
  maxResponseBytes: number;
  token?: string;
};

const repositorySchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
const sha = z.string().regex(/^[0-9a-f]{40}$/);
const refName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/);
const objectResponse = z.object({ sha }).passthrough();
const refResponse = z.object({ object: objectResponse }).passthrough();
const commitResponse = z.object({ sha, tree: objectResponse }).passthrough();
const pullRequestResponse = z
  .object({
    number: z.number().int().positive(),
    html_url: z.url(),
    draft: z.literal(true),
  })
  .passthrough();

function inputError(message: string) {
  return new RepositoryConnectorError("invalid-input", message);
}

function malformed(label: string) {
  return new RepositoryConnectorError("malformed-response", `${label} is malformed.`);
}

function parseExternal<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw malformed(label);
  return result.data;
}

export class GitHubDraftPrApi implements DraftPullRequestApi {
  readonly repository: { owner: string; repo: string };
  readonly #fetcher: Fetcher;
  readonly #maxResponseBytes: number;
  readonly #allowedPaths: ReadonlySet<string>;
  readonly #owner: string;
  readonly #repo: string;
  readonly #token: string;

  constructor(options: GitHubDraftPrApiOptions) {
    const repository = repositorySchema.safeParse(options.repository);
    if (
      !repository.success ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes < 1 ||
      options.maxResponseBytes > 65_536 ||
      options.allowedPaths.length < 1 ||
      options.allowedPaths.length > 16 ||
      options.allowedPaths.some((path) => !isSafeRepositoryPath(path)) ||
      new Set(options.allowedPaths).size !== options.allowedPaths.length ||
      options.token === undefined ||
      options.token.length < 1 ||
      options.token.length > 4_096
    ) {
      throw inputError("GitHub draft-PR API policy is invalid.");
    }
    this.repository = repository.data;
    this.#owner = repository.data.owner;
    this.#repo = repository.data.repo;
    this.#fetcher = options.fetcher ?? fetch;
    this.#maxResponseBytes = options.maxResponseBytes;
    this.#allowedPaths = new Set(options.allowedPaths);
    this.#token = options.token;
  }

  async getBase(branch: string) {
    const normalizedBranch = this.#requireRef(branch);
    const rawRef = await this.#request(
      "GET",
      `/git/ref/heads/${encodeURIComponent(normalizedBranch)}`,
    );
    const ref = parseExternal(refResponse, rawRef, "GitHub base ref response");
    const rawCommit = await this.#request("GET", `/git/commits/${ref.object.sha}`);
    const commit = parseExternal(commitResponse, rawCommit, "GitHub base commit response");
    if (commit.sha !== ref.object.sha) throw malformed("GitHub base commit response");
    return { sha: commit.sha, treeSha: commit.tree.sha };
  }

  async getFile(ref: string, path: string) {
    const normalizedRef = this.#requireRef(ref);
    if (!isSafeRepositoryPath(path) || !this.#allowedPaths.has(path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const rawFile = await this.#request(
      "GET",
      `/contents/${encodedPath}?ref=${encodeURIComponent(normalizedRef)}`,
    );
    const encodedLimit = Math.ceil(this.#maxResponseBytes / 3) * 4;
    const file = parseExternal(
      z
        .object({
          type: z.literal("file"),
          path: z.literal(path),
          sha,
          size: z.number().int().nonnegative().max(this.#maxResponseBytes),
          encoding: z.literal("base64"),
          content: z.string().max(encodedLimit + Math.ceil(encodedLimit / 60) + 2),
        })
        .passthrough(),
      rawFile,
      "GitHub file response",
    );
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
    let content: string;
    try {
      content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw malformed("GitHub file response");
    }
    return { blobSha: file.sha, content };
  }

  async findOpenDraftPullRequest(branch: string) {
    const normalizedBranch = this.#requireRef(branch);
    const rawPullRequests = await this.#request(
      "GET",
      `/pulls?state=open&head=${encodeURIComponent(`${this.#owner}:${normalizedBranch}`)}&per_page=2`,
    );
    const pullRequests = parseExternal(
      z.array(pullRequestResponse).max(2),
      rawPullRequests,
      "GitHub pull request response",
    );
    if (pullRequests.length > 1) {
      throw new RepositoryConnectorError(
        "malformed-response",
        "Multiple draft pull requests use the deterministic remediation branch.",
      );
    }
    const pullRequest = pullRequests[0];
    return pullRequest === undefined ? null : this.#normalizePullRequest(pullRequest);
  }

  async getBranch(branch: string) {
    const normalizedBranch = this.#requireRef(branch);
    const raw = await this.#request(
      "GET",
      `/git/ref/heads/${encodeURIComponent(normalizedBranch)}`,
      undefined,
      true,
    );
    if (raw === null) return null;
    const ref = parseExternal(refResponse, raw, "GitHub branch response");
    return { sha: ref.object.sha };
  }

  async getChangedPaths(baseSha: string, headSha: string) {
    const base = this.#requireSha(baseSha);
    const head = this.#requireSha(headSha);
    const raw = await this.#request("GET", `/compare/${base}...${head}`);
    const comparison = parseExternal(
      z
        .object({
          status: z.literal("ahead"),
          ahead_by: z.literal(1),
          behind_by: z.literal(0),
          total_commits: z.literal(1),
          base_commit: z.object({ sha }).passthrough(),
          commits: z.array(z.object({ sha }).passthrough()).length(1),
          files: z.array(z.object({ filename: z.string().min(1).max(512) }).passthrough()).max(16),
        })
        .passthrough(),
      raw,
      "GitHub branch comparison response",
    );
    if (
      comparison.base_commit.sha !== base ||
      comparison.commits[0]?.sha !== head ||
      comparison.files.some((file) => !isSafeRepositoryPath(file.filename))
    ) {
      throw malformed("GitHub branch comparison response");
    }
    return comparison.files.map((file) => file.filename);
  }

  async createBlob(content: string) {
    if (new TextEncoder().encode(content).byteLength > 32_768) {
      throw new RepositoryConnectorError("limit-exceeded", "GitHub blob byte limit exceeded.");
    }
    const raw = await this.#request("POST", "/git/blobs", { content, encoding: "utf-8" });
    return parseExternal(objectResponse, raw, "GitHub blob response");
  }

  async createTree(input: { baseTreeSha: string; path: string; blobSha: string }) {
    const baseTreeSha = this.#requireSha(input.baseTreeSha);
    const blobSha = this.#requireSha(input.blobSha);
    if (!isSafeRepositoryPath(input.path) || !this.#allowedPaths.has(input.path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    const raw = await this.#request("POST", "/git/trees", {
      base_tree: baseTreeSha,
      tree: [{ path: input.path, mode: "100644", type: "blob", sha: blobSha }],
    });
    return parseExternal(objectResponse, raw, "GitHub tree response");
  }

  async createCommit(input: { message: string; treeSha: string; parentSha: string }) {
    if (input.message.length < 1 || input.message.length > 120) {
      throw inputError("GitHub commit message is invalid.");
    }
    const raw = await this.#request("POST", "/git/commits", {
      message: input.message,
      tree: this.#requireSha(input.treeSha),
      parents: [this.#requireSha(input.parentSha)],
    });
    return parseExternal(objectResponse, raw, "GitHub commit response");
  }

  async createBranch(branch: string, commitSha: string) {
    const ref = `refs/heads/${this.#requireRef(branch)}`;
    const commit = this.#requireSha(commitSha);
    const raw = await this.#request("POST", "/git/refs", {
      ref,
      sha: commit,
    });
    parseExternal(
      z
        .object({ ref: z.literal(ref), object: z.object({ sha: z.literal(commit) }).passthrough() })
        .passthrough(),
      raw,
      "GitHub branch response",
    );
  }

  async createDraftPullRequest(input: { title: string; body: string; head: string; base: string }) {
    if (
      input.title.length < 1 ||
      input.title.length > 120 ||
      new TextEncoder().encode(input.body).byteLength > 16_384
    ) {
      throw new RepositoryConnectorError("limit-exceeded", "Draft pull request limit exceeded.");
    }
    const raw = await this.#request("POST", "/pulls", {
      title: input.title,
      body: input.body,
      head: this.#requireRef(input.head),
      base: this.#requireRef(input.base),
      draft: true,
    });
    return this.#normalizePullRequest(
      parseExternal(pullRequestResponse, raw, "GitHub draft pull request response"),
    );
  }

  #normalizePullRequest(pullRequest: z.infer<typeof pullRequestResponse>) {
    const url = new URL(pullRequest.html_url);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "github.com" ||
      url.pathname !== `/${this.#owner}/${this.#repo}/pull/${pullRequest.number}`
    ) {
      throw malformed("GitHub draft pull request response");
    }
    return { number: pullRequest.number, url: pullRequest.html_url, draft: true as const };
  }

  #requireSha(value: string) {
    const result = sha.safeParse(value);
    if (!result.success) throw inputError("A full immutable Git SHA is required.");
    return result.data;
  }

  #requireRef(value: string) {
    const result = refName.safeParse(value);
    if (!result.success || value.includes("..") || value.endsWith("/")) {
      throw inputError("GitHub ref is invalid.");
    }
    return result.data;
  }

  async #request(
    method: "GET" | "POST",
    endpoint: string,
    body?: unknown,
    allowNotFound = false,
  ): Promise<unknown> {
    const url = new URL(
      `/repos/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}${endpoint}`,
      "https://api.github.com",
    );
    const headers = new Headers({
      accept: "application/vnd.github+json",
      authorization: `Bearer ${this.#token}`,
      "x-github-api-version": "2022-11-28",
    });
    let serializedBody: string | undefined;
    if (body !== undefined) {
      serializedBody = JSON.stringify(body);
      if (new TextEncoder().encode(serializedBody).byteLength > 65_536) {
        throw new RepositoryConnectorError("limit-exceeded", "GitHub request byte limit exceeded.");
      }
      headers.set("content-type", "application/json");
    }
    let response: Response;
    try {
      response = await this.#fetcher(
        new Request(url, {
          method,
          headers,
          ...(serializedBody === undefined ? {} : { body: serializedBody }),
        }),
      );
    } catch {
      throw new RepositoryConnectorError("unavailable", "GitHub request failed before a response.");
    }
    if (allowNotFound && response.status === 404) return null;
    if (!response.ok) {
      throw new RepositoryConnectorError(
        "unavailable",
        `GitHub request failed with HTTP ${response.status}.`,
      );
    }
    const declaredLength = response.headers.get("content-length");
    if (declaredLength !== null) {
      if (!/^(?:0|[1-9]\d*)$/.test(declaredLength)) throw malformed("GitHub content length");
      const length = Number.parseInt(declaredLength, 10);
      if (!Number.isSafeInteger(length)) throw malformed("GitHub content length");
      if (length > this.#maxResponseBytes) {
        throw new RepositoryConnectorError(
          "limit-exceeded",
          "GitHub response byte limit exceeded.",
        );
      }
    }
    if (response.body === null) throw malformed("GitHub response");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const result = await reader.read();
        if (result.done) break;
        total += result.value.byteLength;
        if (total > this.#maxResponseBytes) {
          await reader.cancel();
          throw new RepositoryConnectorError(
            "limit-exceeded",
            "GitHub response byte limit exceeded.",
          );
        }
        chunks.push(result.value);
      }
    } catch (error) {
      if (error instanceof RepositoryConnectorError) throw error;
      throw new RepositoryConnectorError("unavailable", "GitHub response stream failed.");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw malformed("GitHub response");
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      throw malformed("GitHub response");
    }
  }
}
