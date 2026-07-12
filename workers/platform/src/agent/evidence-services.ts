import { regressionSource } from "../../../../packages/test-fixtures/src/scenario";
import { regressionHealthSource } from "../../../../packages/test-fixtures/src/remediation";
import { GitHubFetchApi, RepositoryConnector, RepositoryConnectorError } from "../github";
import type { InvestigationEvidenceServices } from "./tools";

type EvidenceStore = InvestigationEvidenceServices["telemetry"] & {
  getReleaseAttribution(releaseId: string): Promise<{
    versionId: string;
    commitSha: string;
  } | null>;
};

type EvidenceServiceOptions = {
  mode: string;
  repository: { owner: string; repo: string };
  store: EvidenceStore;
  fetcher?: (request: Request) => Promise<Response>;
  token?: string;
};

const regressionFile = {
  path: "workers/platform/src/api/health.ts",
  blobSha: "3333333333333333333333333333333333333333",
  byteLength: new TextEncoder().encode(regressionHealthSource).byteLength,
  content: regressionHealthSource,
} as const;

function createDeterministicRepository(
  store: EvidenceStore,
  repository: { owner: string; repo: string },
) {
  return {
    async inspectRelease(versionId: string) {
      const release = await store.getReleaseAttribution(versionId);
      if (release === null) {
        throw new RepositoryConnectorError("unavailable", "Release evidence is unavailable.");
      }
      if (
        versionId === "regression-sequential" &&
        release.commitSha !== regressionSource.commitSha
      ) {
        throw new RepositoryConnectorError(
          "malformed-response",
          "Regression release attribution does not match its immutable source.",
        );
      }
      const commitUrl = `https://github.com/${repository.owner}/${repository.repo}/commit/${release.commitSha}`;
      if (versionId !== "regression-sequential") {
        return {
          release,
          commit: {
            sha: release.commitSha,
            message: "Known-good concurrent health loading",
            committedAt: "2026-07-12T01:08:25Z",
            authorLogin: "alexlopashev",
            url: commitUrl,
            changes: [],
          },
          pullRequest: { status: "unknown" as const, reason: "not-found" as const },
        };
      }
      return {
        release,
        commit: {
          sha: release.commitSha,
          message: "perf: serialize health checks to limit pressure (#19)",
          committedAt: "2026-07-12T01:42:21Z",
          authorLogin: "alexlopashev",
          url: commitUrl,
          changes: [
            {
              path: regressionFile.path,
              status: "modified" as const,
              additions: 14,
              deletions: 4,
              patch: "+ if sequential, await each service check before starting the next",
            },
          ],
        },
        pullRequest: {
          status: "found" as const,
          number: regressionSource.pullRequestNumber,
          title: "Scenario: serialize health checks to limit downstream pressure",
          authorLogin: "alexlopashev",
          baseSha: "cf25e5253b106b1e7514340abe94bd42fd748725",
          headSha: release.commitSha,
          mergedAt: "2026-07-12T01:42:21Z",
          url: `https://github.com/${repository.owner}/${repository.repo}/pull/${regressionSource.pullRequestNumber}`,
        },
      };
    },

    async readFiles(input: { commitSha: string; paths: readonly string[] }) {
      if (input.commitSha !== regressionSource.commitSha) {
        throw new RepositoryConnectorError(
          "not-allowed",
          "Deterministic source is pinned to the regression commit.",
        );
      }
      if (input.paths.length !== 1 || input.paths[0] !== regressionFile.path) {
        throw new RepositoryConnectorError(
          "not-allowed",
          "Deterministic source path is not allowlisted.",
        );
      }
      return [regressionFile];
    },
  };
}

export function createAgentEvidenceServices(
  options: EvidenceServiceOptions,
): InvestigationEvidenceServices {
  if (options.mode === "fake") {
    return {
      telemetry: options.store,
      repository: createDeterministicRepository(options.store, options.repository),
    };
  }
  if (options.mode !== "workers-ai") {
    throw new TypeError(`Unsupported evidence mode: ${options.mode}`);
  }

  const api = new GitHubFetchApi({
    repository: options.repository,
    maxResponseBytes: 64 * 1_024,
    ...(options.fetcher === undefined ? {} : { fetcher: options.fetcher }),
    ...(options.token === undefined ? {} : { token: options.token }),
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
