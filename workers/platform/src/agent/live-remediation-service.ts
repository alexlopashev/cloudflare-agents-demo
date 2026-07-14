import { GitHubDraftPrApi, GitHubPublicPreviewApi } from "../github";
import { createRemediationService } from "../remediation/service";
import type { RemediationServiceOptions } from "./remediation-services";

const allowedPaths = ["workers/platform/src/api/health.ts"] as const;
const limits = { maxFileBytes: 16_384, maxChangedLines: 80, maxLines: 400 } as const;

export function createLiveRemediationService(options: RemediationServiceOptions) {
  const trimmedToken = options.token?.trim();
  const token = trimmedToken === undefined || trimmedToken.length === 0 ? undefined : trimmedToken;
  if (options.writeEnabled && token === undefined) {
    throw new TypeError("GitHub writes require an explicit non-empty scoped token.");
  }
  const api =
    token === undefined
      ? new GitHubPublicPreviewApi({
          repository: options.repository,
          allowedPaths,
          maxResponseBytes: 64 * 1_024,
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        })
      : new GitHubDraftPrApi({
          repository: options.repository,
          allowedPaths,
          maxResponseBytes: 64 * 1_024,
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
          token,
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
