export const evidenceToolNames = [
  "compare_releases",
  "find_slow_traces",
  "inspect_trace",
  "inspect_release",
  "read_repo_files",
] as const;

export const evidenceErrorCodes = [
  "invalid-input",
  "not-allowed",
  "limit-exceeded",
  "rate-limited",
  "unavailable",
  "malformed-response",
  "not-found",
  "incident-mismatch",
] as const;

export type EvidenceToolName = (typeof evidenceToolNames)[number];
