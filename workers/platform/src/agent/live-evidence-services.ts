import { GitHubFetchApi, RepositoryConnector, RepositoryConnectorError } from "../github";
import type { EvidenceServiceOptions } from "./evidence-services";
import type { InvestigationEvidenceServices } from "./tools";

export function createLiveEvidenceServices(
  options: EvidenceServiceOptions,
): InvestigationEvidenceServices {
  const token = options.token?.trim();
  const normalizedToken = token === undefined || token.length === 0 ? undefined : token;
  const api = new GitHubFetchApi({
    repository: options.repository,
    maxResponseBytes: 64 * 1_024,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(normalizedToken === undefined ? {} : { token: normalizedToken }),
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
