export type RepositoryConnectorErrorCode =
  | "invalid-input"
  | "not-allowed"
  | "limit-exceeded"
  | "rate-limited"
  | "unavailable"
  | "malformed-response"
  | "not-found";

export class RepositoryConnectorError extends Error {
  readonly code: RepositoryConnectorErrorCode;
  readonly retryAtEpochSeconds: number | undefined;

  constructor(
    code: RepositoryConnectorErrorCode,
    message: string,
    options: { retryAtEpochSeconds?: number } = {},
  ) {
    super(message);
    this.name = "RepositoryConnectorError";
    this.code = code;
    this.retryAtEpochSeconds = options.retryAtEpochSeconds;
  }
}
