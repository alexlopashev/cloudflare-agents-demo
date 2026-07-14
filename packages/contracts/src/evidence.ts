export const evidenceToolNames = [
  "compare_releases",
  "find_slow_traces",
  "inspect_trace",
  "inspect_release",
  "read_repo_files",
] as const;

export type EvidenceToolName = (typeof evidenceToolNames)[number];
