import { z } from "zod";

import { isSafeRepositoryPath } from "../github/path-policy";

const sha = z.string().regex(/^[0-9a-f]{40}$/);
const evidenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const repositorySchema = z
  .object({
    owner: z.string().regex(/^[A-Za-z0-9_.-]+$/),
    repo: z.string().regex(/^[A-Za-z0-9_.-]+$/),
  })
  .strict();
export const remediationProposalSchema = z
  .object({
    incident: z
      .object({
        baselineReleaseId: evidenceId,
        degradedReleaseId: evidenceId,
        traceId: evidenceId,
        regressionCommitSha: sha,
        sourcePullRequestNumber: z.number().int().positive(),
      })
      .strict(),
    expectedBaseSha: sha,
    expectedBlobSha: sha,
    path: z.string().min(1).max(512),
    replacementContent: z.string().min(1),
    title: z.string().min(1).max(120),
    rationale: z.string().min(1).max(2_000),
    risk: z.string().min(1).max(1_000),
    validationSteps: z.array(z.string().min(1).max(300)).min(1).max(10),
  })
  .strict();

export type RemediationProposal = z.infer<typeof remediationProposalSchema>;

export type DraftPullRequestApi = {
  readonly repository: { owner: string; repo: string };
  getBase(branch: string): Promise<unknown>;
  getFile(ref: string, path: string): Promise<unknown>;
  findOpenDraftPullRequest(branch: string): Promise<unknown>;
  getBranch(branch: string): Promise<unknown>;
  getChangedPaths(baseSha: string, headSha: string): Promise<unknown>;
  createBlob(content: string): Promise<unknown>;
  createTree(input: { baseTreeSha: string; path: string; blobSha: string }): Promise<unknown>;
  createCommit(input: { message: string; treeSha: string; parentSha: string }): Promise<unknown>;
  createBranch(branch: string, commitSha: string): Promise<void>;
  createDraftPullRequest(input: {
    title: string;
    body: string;
    head: string;
    base: string;
  }): Promise<unknown>;
};

type RemediationLimits = {
  maxFileBytes: number;
  maxChangedLines: number;
  maxLines: number;
};

type RemediationServiceOptions = {
  api: DraftPullRequestApi;
  repository: { owner: string; repo: string };
  baseBranch: string;
  allowedPaths: readonly string[];
  limits: RemediationLimits;
  writeEnabled: boolean;
};

export type RemediationErrorCode =
  | "invalid-input"
  | "not-allowed"
  | "limit-exceeded"
  | "stale-base"
  | "stale-blob"
  | "unavailable"
  | "malformed-response";

export class RemediationError extends Error {
  readonly code: RemediationErrorCode;

  constructor(code: RemediationErrorCode, message: string) {
    super(message);
    this.name = "RemediationError";
    this.code = code;
  }
}

const baseResponse = z.object({ sha, treeSha: sha }).strict();
const fileResponse = z.object({ blobSha: sha, content: z.string() }).strict();
const objectResponse = z.object({ sha }).strict();
const branchResponse = z.object({ sha }).strict().nullable();
const pullRequestResponse = z
  .object({ number: z.number().int().positive(), url: z.url(), draft: z.literal(true) })
  .strict();

function parseExternal<T>(schema: z.ZodType<T>, value: unknown, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new RemediationError("malformed-response", `${label} did not match its contract.`);
  }
  return result.data;
}

function lineCount(value: string): number {
  return value.length === 0 ? 0 : value.split("\n").length;
}

function changedLines(before: string, after: string) {
  const left = before.split("\n");
  const right = after.split("\n");
  let previous = new Uint16Array(right.length + 1);
  for (const leftLine of left) {
    const current = new Uint16Array(right.length + 1);
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] =
        leftLine === right[rightIndex - 1]
          ? (previous[rightIndex - 1] ?? 0) + 1
          : Math.max(previous[rightIndex] ?? 0, current[rightIndex - 1] ?? 0);
    }
    previous = current;
  }
  const common = previous[right.length] ?? 0;
  return { additions: right.length - common, deletions: left.length - common };
}

async function fingerprint(proposal: RemediationProposal): Promise<string> {
  const identity = JSON.stringify({
    incident: proposal.incident,
    expectedBaseSha: proposal.expectedBaseSha,
    expectedBlobSha: proposal.expectedBlobSha,
    path: proposal.path,
    replacementContent: proposal.replacementContent,
  });
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

function pullRequestBody(proposal: RemediationProposal, changes: ReturnType<typeof changedLines>) {
  return `## Evidence

- Baseline release: ${proposal.incident.baselineReleaseId}
- Degraded release: ${proposal.incident.degradedReleaseId}
- Representative trace: ${proposal.incident.traceId}
- Regression commit: ${proposal.incident.regressionCommitSha}
- Source PR: PR #${proposal.incident.sourcePullRequestNumber}

## Rationale

${proposal.rationale}

## Scope

- ${proposal.path}
- ${changes.additions} additions, ${changes.deletions} deletions

## Risk

${proposal.risk}

## Validation

${proposal.validationSteps.map((step) => `- [ ] ${step}`).join("\n")}
`;
}

function asUnavailable(): RemediationError {
  return new RemediationError("unavailable", "GitHub remediation is temporarily unavailable.");
}

export function createRemediationService(options: RemediationServiceOptions) {
  const repository = repositorySchema.safeParse(options.repository);
  const baseBranch = z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/)
    .safeParse(options.baseBranch);
  const positiveLimit = (value: number) => Number.isSafeInteger(value) && value > 0;
  if (
    !repository.success ||
    !baseBranch.success ||
    options.allowedPaths.length < 1 ||
    options.allowedPaths.length > 16 ||
    options.allowedPaths.some((path) => !isSafeRepositoryPath(path)) ||
    new Set(options.allowedPaths).size !== options.allowedPaths.length ||
    !positiveLimit(options.limits.maxFileBytes) ||
    !positiveLimit(options.limits.maxChangedLines) ||
    !positiveLimit(options.limits.maxLines) ||
    options.api.repository.owner !== repository.data.owner ||
    options.api.repository.repo !== repository.data.repo
  ) {
    throw new RemediationError("invalid-input", "Remediation policy is invalid.");
  }
  const repositoryName = `${repository.data.owner}/${repository.data.repo}`;
  const allowedPaths = new Set(options.allowedPaths);

  const prepare = async (proposal: RemediationProposal) => {
    let rawBase: unknown;
    let rawFile: unknown;
    try {
      rawBase = await options.api.getBase(baseBranch.data);
      rawFile = await options.api.getFile(proposal.expectedBaseSha, proposal.path);
    } catch (error) {
      if (error instanceof RemediationError) throw error;
      throw asUnavailable();
    }
    const base = parseExternal(baseResponse, rawBase, "Base branch");
    if (base.sha !== proposal.expectedBaseSha) {
      throw new RemediationError("stale-base", "The configured base branch has moved.");
    }
    const file = parseExternal(fileResponse, rawFile, "Base file");
    if (file.blobSha !== proposal.expectedBlobSha) {
      throw new RemediationError("stale-blob", "The proposed source blob is stale.");
    }
    if (file.content === proposal.replacementContent) {
      throw new RemediationError("invalid-input", "The proposal does not change the source file.");
    }
    if (
      new TextEncoder().encode(proposal.replacementContent).byteLength >
        options.limits.maxFileBytes ||
      lineCount(file.content) > options.limits.maxLines ||
      lineCount(proposal.replacementContent) > options.limits.maxLines
    ) {
      throw new RemediationError("limit-exceeded", "Remediation file size limit exceeded.");
    }
    const changes = changedLines(file.content, proposal.replacementContent);
    if (changes.additions + changes.deletions > options.limits.maxChangedLines) {
      throw new RemediationError("limit-exceeded", "Remediation changed-line limit exceeded.");
    }
    return { base, changes, body: pullRequestBody(proposal, changes) };
  };

  return {
    async execute(rawProposal: RemediationProposal) {
      const parsed = remediationProposalSchema.safeParse(rawProposal);
      if (!parsed.success) {
        throw new RemediationError("invalid-input", "Remediation proposal is invalid.");
      }
      const proposal = parsed.data;
      if (!allowedPaths.has(proposal.path)) {
        throw new RemediationError("not-allowed", "Remediation path is not allowlisted.");
      }
      if (proposal.expectedBaseSha !== proposal.incident.regressionCommitSha) {
        throw new RemediationError(
          "invalid-input",
          "The remediation base does not match the evidenced regression commit.",
        );
      }
      const incidentFingerprint = await fingerprint(proposal);
      const branch = `regression-surgeon/${incidentFingerprint}`;

      if (options.writeEnabled) {
        let existing: unknown;
        try {
          existing = await options.api.findOpenDraftPullRequest(branch);
        } catch {
          throw asUnavailable();
        }
        if (existing !== null) {
          const pullRequest = parseExternal(
            pullRequestResponse,
            existing,
            "Existing draft pull request",
          );
          return {
            status: "reused" as const,
            writesPerformed: false,
            repository: repositoryName,
            branch,
            ...pullRequest,
          };
        }
      }

      const prepared = await prepare(proposal);
      const preview = {
        status: "preview" as const,
        writesPerformed: false as const,
        repository: repositoryName,
        branch,
        title: proposal.title,
        body: prepared.body,
        file: {
          path: proposal.path,
          additions: prepared.changes.additions,
          deletions: prepared.changes.deletions,
          byteLength: new TextEncoder().encode(proposal.replacementContent).byteLength,
          expectedBlobSha: proposal.expectedBlobSha,
        },
      };
      if (!options.writeEnabled) return preview;

      let rawBranch: unknown;
      let commitSha: string;
      try {
        rawBranch = await options.api.getBranch(branch);
      } catch {
        throw asUnavailable();
      }
      const existingBranch = parseExternal(branchResponse, rawBranch, "Remediation branch");
      if (existingBranch !== null) {
        let rawChangedPaths: unknown;
        try {
          rawChangedPaths = await options.api.getChangedPaths(
            proposal.expectedBaseSha,
            existingBranch.sha,
          );
        } catch {
          return { status: "recoverable" as const, branch, stage: "branch-existing" as const };
        }
        const changedPaths = parseExternal(
          z.array(z.string().min(1).max(512)).max(16),
          rawChangedPaths,
          "Remediation branch comparison",
        );
        if (changedPaths.length !== 1 || changedPaths[0] !== proposal.path) {
          throw new RemediationError(
            "not-allowed",
            "The deterministic remediation branch contains changes outside the approved file.",
          );
        }
        let branchFile: unknown;
        try {
          branchFile = await options.api.getFile(branch, proposal.path);
        } catch {
          return { status: "recoverable" as const, branch, stage: "branch-existing" as const };
        }
        const file = parseExternal(fileResponse, branchFile, "Remediation branch file");
        if (file.content !== proposal.replacementContent) {
          throw new RemediationError(
            "stale-blob",
            "The deterministic remediation branch contains different source.",
          );
        }
        try {
          const created = parseExternal(
            pullRequestResponse,
            await options.api.createDraftPullRequest({
              title: proposal.title,
              body: prepared.body,
              head: branch,
              base: baseBranch.data,
            }),
            "Draft pull request",
          );
          return {
            status: "created" as const,
            writesPerformed: true as const,
            repository: repositoryName,
            branch,
            ...created,
          };
        } catch {
          return { status: "recoverable" as const, branch, stage: "branch-existing" as const };
        }
      }

      try {
        const blob = parseExternal(
          objectResponse,
          await options.api.createBlob(proposal.replacementContent),
          "Created blob",
        );
        const tree = parseExternal(
          objectResponse,
          await options.api.createTree({
            baseTreeSha: prepared.base.treeSha,
            path: proposal.path,
            blobSha: blob.sha,
          }),
          "Created tree",
        );
        const commit = parseExternal(
          objectResponse,
          await options.api.createCommit({
            message: proposal.title,
            treeSha: tree.sha,
            parentSha: proposal.expectedBaseSha,
          }),
          "Created commit",
        );
        commitSha = commit.sha;
      } catch (error) {
        if (error instanceof RemediationError) throw error;
        throw asUnavailable();
      }
      try {
        await options.api.createBranch(branch, commitSha);
      } catch {
        return {
          status: "recoverable" as const,
          branch,
          stage: "branch-write-uncertain" as const,
        };
      }

      try {
        const created = parseExternal(
          pullRequestResponse,
          await options.api.createDraftPullRequest({
            title: proposal.title,
            body: prepared.body,
            head: branch,
            base: baseBranch.data,
          }),
          "Draft pull request",
        );
        return {
          status: "created" as const,
          writesPerformed: true as const,
          repository: repositoryName,
          branch,
          ...created,
        };
      } catch {
        return { status: "recoverable" as const, branch, stage: "branch-created" as const };
      }
    },
  };
}
