import {
  regressionHealthSource,
  remediationFixture,
} from "../../../../packages/test-fixtures/src/remediation";
import { GitHubDraftPrApi } from "../github";
import { createRemediationService, type DraftPullRequestApi } from "../remediation/service";

type RemediationServiceOptions = {
  mode: string;
  repository: { owner: string; repo: string };
  writeEnabled: boolean;
  fetcher?: (request: Request) => Promise<Response>;
  token?: string;
};

const allowedPaths = ["workers/platform/src/api/health.ts"] as const;
const limits = { maxFileBytes: 16_384, maxChangedLines: 80, maxLines: 400 } as const;

function createDeterministicApi(repository: { owner: string; repo: string }): DraftPullRequestApi {
  const writesAreForbidden = async (): Promise<never> => {
    throw new Error("Deterministic remediation cannot write to GitHub.");
  };
  return {
    repository,
    async getBase() {
      return { sha: remediationFixture.expectedBaseSha, treeSha: "1".repeat(40) };
    },
    async getFile(ref, path) {
      if (ref !== remediationFixture.expectedBaseSha || path !== remediationFixture.path) {
        throw new Error("Deterministic remediation evidence mismatch.");
      }
      return {
        blobSha: remediationFixture.expectedBlobSha,
        content: regressionHealthSource,
      };
    },
    async findOpenDraftPullRequest() {
      return null;
    },
    async getBranch() {
      return null;
    },
    async getChangedPaths() {
      return [remediationFixture.path];
    },
    createBlob: writesAreForbidden,
    createTree: writesAreForbidden,
    createCommit: writesAreForbidden,
    createBranch: writesAreForbidden,
    createDraftPullRequest: writesAreForbidden,
  };
}

export function createAgentRemediationService(options: RemediationServiceOptions) {
  const token =
    options.token === undefined || options.token.trim().length === 0 ? undefined : options.token;
  if (
    options.mode === "fake" ||
    (options.mode === "workers-ai" && token === undefined && !options.writeEnabled)
  ) {
    return createRemediationService({
      api: createDeterministicApi(options.repository),
      repository: options.repository,
      baseBranch: "main",
      allowedPaths,
      limits,
      writeEnabled: false,
    });
  }
  if (options.mode !== "workers-ai") {
    throw new TypeError(`Unsupported remediation mode: ${options.mode}`);
  }
  if (options.writeEnabled && token === undefined) {
    throw new TypeError("GitHub writes require an explicit non-empty scoped token.");
  }
  const api = new GitHubDraftPrApi({
    repository: options.repository,
    allowedPaths,
    maxResponseBytes: 64 * 1_024,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(token === undefined ? {} : { token }),
  });
  return createRemediationService({
    api,
    repository: options.repository,
    baseBranch: "main",
    allowedPaths,
    limits,
    writeEnabled: options.writeEnabled,
  });
}
