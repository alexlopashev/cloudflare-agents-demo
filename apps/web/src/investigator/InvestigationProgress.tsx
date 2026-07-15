type ProgressPhase = {
  attempts: readonly { reason: string }[];
  status: "pending" | "complete" | "insufficient" | "error";
  toolName: string;
};

type ProgressReceipt = {
  evidence: {
    baselineReleaseId?: string;
    degradedReleaseId?: string;
    selectedTraceId?: string;
    inspectedTraceId?: string;
    commitSha?: string;
    pullRequest?:
      | { status: "found"; number: number }
      | { status: "unknown"; reason: "not-found" | "ambiguous" };
    sourcePath?: string;
  };
  investigationId: string;
  phases: readonly ProgressPhase[];
};

export type InvestigationUpdate = {
  id: string;
  state: "active" | "complete" | "failed";
  text: string;
};

function completeText(receipt: ProgressReceipt, toolName: string): string {
  const evidence = receipt.evidence;
  if (toolName === "compare_releases") {
    return `Validated the bounded comparison between ${evidence.baselineReleaseId ?? "the baseline"} and ${evidence.degradedReleaseId ?? "the degraded release"}.`;
  }
  if (toolName === "find_slow_traces") {
    return `Found degraded-release traces and selected ${evidence.selectedTraceId ?? "a representative slow trace"}.`;
  }
  if (toolName === "inspect_trace") {
    return `Validated the critical path for ${evidence.inspectedTraceId ?? evidence.selectedTraceId ?? "the selected trace"}.`;
  }
  if (toolName === "inspect_release") {
    const commit = evidence.commitSha?.slice(0, 12) ?? "an immutable commit";
    const pullRequest =
      evidence.pullRequest?.status === "found"
        ? ` and PR #${evidence.pullRequest.number}`
        : "; pull-request metadata remains unknown";
    return `Mapped the degraded release to commit ${commit}${pullRequest}.`;
  }
  if (toolName === "read_repo_files") {
    return `Read the allowlisted source ${evidence.sourcePath ?? "at the evidenced commit"}.`;
  }
  return `Completed ${toolName}.`;
}

function activeText(toolName: string): string {
  if (toolName === "compare_releases") return "Comparing baseline and degraded release metrics…";
  if (toolName === "find_slow_traces") return "Searching the bounded degraded-release window…";
  if (toolName === "inspect_trace") return "Inspecting one representative critical path…";
  if (toolName === "inspect_release") return "Resolving the release to a commit and source PR…";
  if (toolName === "read_repo_files") return "Reading the allowlisted source at that commit…";
  return `Gathering ${toolName} evidence…`;
}

export function buildInvestigationUpdates(receipt: ProgressReceipt): InvestigationUpdate[] {
  const updates: InvestigationUpdate[] = [];
  for (const phase of receipt.phases) {
    const id = `${receipt.investigationId}-${phase.toolName}`;
    if (phase.status === "complete") {
      updates.push({ id, state: "complete", text: completeText(receipt, phase.toolName) });
      continue;
    }
    if (phase.status === "pending") {
      updates.push({ id, state: "active", text: activeText(phase.toolName) });
      break;
    }
    const reason = phase.attempts.at(-1)?.reason ?? "bounded evidence unavailable";
    updates.push({ id, state: "failed", text: `${activeText(phase.toolName)} ${reason}.` });
    break;
  }
  return updates;
}

export function InvestigationProgress({ receipt }: { receipt: ProgressReceipt }) {
  const updates = buildInvestigationUpdates(receipt);
  if (updates.length === 0) return null;
  return (
    <article aria-live="polite" className="message assistant progress-message">
      <span>Investigator work log</span>
      <ol>
        {updates.map((update) => (
          <li className={update.state} key={update.id}>
            {update.text}
          </li>
        ))}
      </ol>
    </article>
  );
}
