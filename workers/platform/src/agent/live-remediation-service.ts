import { GitHubDraftPrApi, PersistedPreviewApi } from "../github";
import { createRemediationService, type RemediationReadApi } from "../remediation/service";
import type { RemediationServiceOptions } from "./remediation-services";

const allowedPaths = ["workers/platform/src/api/health.ts"] as const;
const limits = { maxFileBytes: 16_384, maxChangedLines: 80, maxLines: 400 } as const;

export function createLiveRemediationService(options: RemediationServiceOptions) {
  const trimmedToken = options.token?.trim();
  const token = trimmedToken === undefined || trimmedToken.length === 0 ? undefined : trimmedToken;
  if (options.writeEnabled) {
    if (token === undefined) {
      throw new TypeError("GitHub writes require an explicit non-empty scoped token.");
    }
    return createRemediationService({
      api: new GitHubDraftPrApi({
        repository: options.repository,
        allowedPaths,
        maxResponseBytes: 64 * 1_024,
        ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        token,
      }),
      repository: options.repository,
      baseBranch: "main",
      allowedPaths,
      limits,
      writeEnabled: true,
    });
  }
  let api: RemediationReadApi;
  if (token === undefined) {
    const { store, sourceReleaseId, previewBaseSha } = options;
    if (store === undefined || sourceReleaseId === undefined || previewBaseSha === undefined) {
      throw new TypeError("Credential-free preview requires persisted source evidence.");
    }
    api = new PersistedPreviewApi({
      repository: options.repository,
      releaseId: sourceReleaseId,
      baseSha: previewBaseSha,
      store,
    });
  } else {
    api = new GitHubDraftPrApi({
      repository: options.repository,
      allowedPaths,
      maxResponseBytes: 64 * 1_024,
      ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
      token,
    });
  }
  return createRemediationService({
    api,
    repository: options.repository,
    baseBranch: "main",
    allowedPaths,
    limits,
    writeEnabled: false,
  });
}
