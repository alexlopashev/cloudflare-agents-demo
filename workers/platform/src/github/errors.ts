export type RepositoryConnectorErrorCode =
  | "invalid-input"
  | "not-allowed"
  | "limit-exceeded"
  | "rate-limited"
  | "unavailable"
  | "malformed-response"
  | "not-found";

export const githubDraftPrOperations = [
  "read-base-ref",
  "read-base-commit",
  "read-source-file",
  "find-draft-pr",
  "read-remediation-branch",
  "compare-remediation-branch",
  "create-blob",
  "create-tree",
  "create-commit",
  "create-branch",
  "create-draft-pr",
] as const;

export type GitHubDraftPrOperation = (typeof githubDraftPrOperations)[number];

export class RepositoryConnectorError extends Error {
  readonly code: RepositoryConnectorErrorCode;
  readonly retryAtEpochSeconds: number | undefined;
  readonly operation: GitHubDraftPrOperation | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    code: RepositoryConnectorErrorCode,
    message: string,
    options: {
      retryAtEpochSeconds?: number;
      operation?: GitHubDraftPrOperation;
      httpStatus?: number;
    } = {},
  ) {
    super(message);
    this.name = "RepositoryConnectorError";
    this.code = code;
    this.retryAtEpochSeconds = options.retryAtEpochSeconds;
    this.operation = options.operation;
    this.httpStatus = options.httpStatus;
  }
}
