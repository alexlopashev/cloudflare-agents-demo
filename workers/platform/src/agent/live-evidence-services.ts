import {
  GitHubFetchApi,
  GitHubPublicFetchApi,
  RepositoryConnector,
  RepositoryConnectorError,
} from "../github";
import type { EvidenceServiceOptions } from "./evidence-services";
import type { InvestigationEvidenceServices } from "./tools";

const configuredPublicProvenance = {
  pullRequestNumber: 19,
  pullRequestBaseSha: "cf25e5253b106b1e7514340abe94bd42fd748725",
  pullRequestHeadSha: "9af361e5a9420323b2c86f2670e3bf812ac58620",
  sourcePath: "workers/platform/src/api/health.ts",
} as const;

export function createLiveEvidenceServices(
  options: EvidenceServiceOptions,
): InvestigationEvidenceServices {
  const token = options.token?.trim();
  const normalizedToken = token === undefined || token.length === 0 ? undefined : token;
  const api =
    normalizedToken === undefined
      ? new GitHubPublicFetchApi({
          repository: options.repository,
          maxResponseBytes: 64 * 1_024,
          provenance: configuredPublicProvenance,
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
        })
      : new GitHubFetchApi({
          repository: options.repository,
          maxResponseBytes: 64 * 1_024,
          ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
          token: normalizedToken,
        });
  const repository = new RepositoryConnector({
    api,
    releases: {
      resolve: async (versionId) => {
        const release = await options.store.getReleaseAttribution(versionId);
        if (release === null) {
          throw new RepositoryConnectorError("unavailable", "Release evidence is unavailable.");
        }
        return release;
      },
    },
    repository: options.repository,
    allowedPathPrefixes: ["apps/web/src/", "workers/platform/src/api/"],
    limits: {
      maxApiResponseBytes: 64 * 1_024,
      maxChangedFiles: 32,
      maxFiles: 4,
      maxFileBytes: 32 * 1_024,
      maxPatchBytes: 32 * 1_024,
      maxTotalBytes: 64 * 1_024,
    },
  });
  return { telemetry: options.store, repository };
}
