import { z } from "zod";

import { RepositoryConnectorError } from "./errors";
import { isSafeRepositoryPath } from "./path-policy";
import type { GitHubRepositoryApi } from "./repository-connector";

type Fetcher = (request: Request) => Promise<Response>;

type GitHubPublicFetchApiOptions = {
  fetcher?: Fetcher;
  repository: { owner: string; repo: string };
  maxResponseBytes: number;
};

const repositorySchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
const immutableSha = z.string().regex(/^[0-9a-f]{40}$/i);

function malformed(label: string): RepositoryConnectorError {
  return new RepositoryConnectorError("malformed-response", `${label} did not match its contract.`);
}

export class GitHubPublicFetchApi implements GitHubRepositoryApi {
  readonly repository: { owner: string; repo: string };
  readonly maxResponseBytes: number;
  readonly #fetcher: Fetcher;
  readonly #owner: string;
  readonly #repo: string;

  constructor(options: GitHubPublicFetchApiOptions) {
    const repository = repositorySchema.safeParse(options.repository);
    if (
      !repository.success ||
      !Number.isSafeInteger(options.maxResponseBytes) ||
      options.maxResponseBytes <= 0
    ) {
      throw new RepositoryConnectorError("invalid-input", "GitHub public policy is invalid.");
    }
    this.#fetcher = options.fetcher ?? fetch;
    this.#owner = repository.data.owner;
    this.#repo = repository.data.repo;
    this.repository = { owner: this.#owner, repo: this.#repo };
    this.maxResponseBytes = options.maxResponseBytes;
  }

  async getCommit(commitSha: string, pageSize: number): Promise<unknown> {
    const parsed = await this.#readPatch(commitSha);
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RepositoryConnectorError("invalid-input", "GitHub page size is invalid.");
    }
    if (parsed.files.length > pageSize) {
      throw new RepositoryConnectorError("limit-exceeded", "Commit changed-file limit exceeded.");
    }
    return {
      sha: parsed.sha,
      html_url: `https://github.com/${this.#owner}/${this.#repo}/commit/${parsed.sha}`,
      commit: {
        message: parsed.subject,
        committer: { date: parsed.committedAt },
      },
      author: null,
      files: parsed.files,
    };
  }

  async getPullRequestsForCommit(commitSha: string, pageSize: number): Promise<unknown> {
    if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
      throw new RepositoryConnectorError("invalid-input", "GitHub page size is invalid.");
    }
    const parsed = await this.#readPatch(commitSha);
    const match = /\s\(#([1-9]\d*)\)$/.exec(parsed.subject);
    if (match?.[1] === undefined) return [];
    const number = Number.parseInt(match[1], 10);
    if (!Number.isSafeInteger(number)) throw malformed("GitHub public patch");
    return [
      {
        source: "public-patch",
        number,
        commitSubject: parsed.subject.slice(0, match.index),
        html_url: `https://github.com/${this.#owner}/${this.#repo}/pull/${number}`,
        head: { sha: parsed.sha },
      },
    ];
  }

  async getFile(commitSha: string, path: string): Promise<unknown> {
    const sha = this.#requireSha(commitSha);
    if (!isSafeRepositoryPath(path)) {
      throw new RepositoryConnectorError("not-allowed", "Repository path is not allowed.");
    }
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const url = new URL(
      `/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/${sha}/${encodedPath}`,
      "https://raw.githubusercontent.com",
    );
    const bytes = await this.#requestBytes(url);
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

  async #readPatch(commitSha: string) {
    const sha = this.#requireSha(commitSha);
    const url = new URL(
      `/${encodeURIComponent(this.#owner)}/${encodeURIComponent(this.#repo)}/commit/${sha}.patch`,
      "https://github.com",
    );
    const bytes = await this.#requestBytes(url);
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes).replaceAll("\r\n", "\n");
    } catch {
      throw malformed("GitHub public patch");
    }
    const headerEnd = text.indexOf("\n\n");
    if (headerEnd < 0 || !text.startsWith(`From ${sha} Mon Sep 17 00:00:00 2001\n`)) {
      throw malformed("GitHub public patch");
    }
    const headers = text.slice(0, headerEnd).split("\n");
    const date = headers.find((line) => line.startsWith("Date: "))?.slice(6);
    const subjectHeader = headers.find((line) => line.startsWith("Subject: "))?.slice(9);
    const timestamp = date === undefined ? Number.NaN : Date.parse(date);
    if (subjectHeader === undefined || !Number.isFinite(timestamp)) {
      throw malformed("GitHub public patch");
    }
    const subject = subjectHeader.replace(/^\[PATCH\]\s+/, "");
    if (subject.length === 0 || subject.length > 1_024) throw malformed("GitHub public patch");

    const allDiffLines = text.match(/^diff --git .+$/gm) ?? [];
    const matches = Array.from(text.matchAll(/^diff --git a\/([^\s]+) b\/([^\s]+)$/gm));
    if (matches.length === 0 || matches.length !== allDiffLines.length) {
      throw malformed("GitHub public patch");
    }
    const files = matches.map((match, index) => {
      const left = match[1];
      const right = match[2];
      if (
        left === undefined ||
        right === undefined ||
        left !== right ||
        !isSafeRepositoryPath(left)
      ) {
        throw malformed("GitHub public patch path");
      }
      const start = match.index + match[0].length;
      const end = matches[index + 1]?.index ?? text.length;
      const diff = text.slice(start, end);
      const additions = (diff.match(/^\+(?!\+\+).*/gm) ?? []).length;
      const deletions = (diff.match(/^-(?!--).*/gm) ?? []).length;
      return {
        filename: left,
        status: diff.includes("\nnew file mode ")
          ? ("added" as const)
          : diff.includes("\ndeleted file mode ")
            ? ("removed" as const)
            : ("modified" as const),
        additions,
        deletions,
      };
    });
    return { sha, subject, committedAt: new Date(timestamp).toISOString(), files };
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
