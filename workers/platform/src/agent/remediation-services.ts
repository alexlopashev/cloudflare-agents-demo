import {
  regressionHealthSource,
  remediationFixture,
} from "../../../../packages/test-fixtures/src/remediation";
import { createRemediationService, type RemediationReadApi } from "../remediation/service";
import { createLiveRemediationService } from "./live-remediation-service";

export { createLiveRemediationService } from "./live-remediation-service";

export type RemediationServiceOptions = {
  repository: { owner: string; repo: string };
  writeEnabled: boolean;
  fetcher?: (request: Request) => Promise<Response>;
  token?: string;
  sourceReleaseId?: string;
  previewBaseSha?: string;
  store?: {
    getReleaseSourceEvidence(releaseId: string): Promise<unknown>;
    getReleasePreviewEvidence(releaseId: string, baseSha: string): Promise<unknown>;
  };
};

const allowedPaths = ["workers/platform/src/api/health.ts"] as const;
const limits = { maxFileBytes: 16_384, maxChangedLines: 80, maxLines: 400 } as const;

function createDeterministicApi(repository: { owner: string; repo: string }): RemediationReadApi {
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
  };
}

export function createDeterministicRemediationService(options: RemediationServiceOptions) {
  return createRemediationService({
    api: createDeterministicApi(options.repository),
    repository: options.repository,
    baseBranch: "main",
    allowedPaths,
    limits,
    writeEnabled: false,
  });
}

export function createAgentRemediationService(
  options: RemediationServiceOptions & { mode: string },
) {
  if (options.mode === "fake") return createDeterministicRemediationService(options);
  if (options.mode === "workers-ai") return createLiveRemediationService(options);
  throw new TypeError(`Unsupported remediation mode: ${options.mode}`);
}
