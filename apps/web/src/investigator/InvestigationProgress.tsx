import { Fragment } from "react";

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
  incident: {
    baselineReleaseId: string;
    degradedReleaseId: string;
    traceWindow: { sinceMs: number; untilMs: number };
  };
  investigationId: string;
  phases: readonly ProgressPhase[];
};

export type InvestigationEvent = {
  id: string;
  kind: "reasoning" | "tool-call" | "tool-result";
  label: string;
  state: "active" | "complete" | "failed";
  text: string;
};

function reasoningText(toolName: string): string {
  if (toolName === "compare_releases") {
    return "Establish the measured release-level regression before selecting trace evidence.";
  }
  if (toolName === "find_slow_traces") {
    return "Use the configured degraded-release window to select one representative slow trace.";
  }
  if (toolName === "inspect_trace") {
    return "Validate the selected trace parentage and critical path before attributing a cause.";
  }
  if (toolName === "inspect_release") {
    return "Resolve the degraded release to immutable commit and pull-request evidence.";
  }
  if (toolName === "read_repo_files") {
    return "Read only the allowlisted changed source at the evidenced commit before proposing a fix.";
  }
  return `Gather the next required ${toolName} evidence.`;
}

function toolCallText(receipt: ProgressReceipt, toolName: string): string {
  const { evidence, incident } = receipt;
  if (toolName === "compare_releases") {
    return `${incident.baselineReleaseId} → ${incident.degradedReleaseId}; equivalent server-bounded windows.`;
  }
  if (toolName === "find_slow_traces") {
    return `${incident.degradedReleaseId}; since ${incident.traceWindow.sinceMs}, until ${incident.traceWindow.untilMs}.`;
  }
  if (toolName === "inspect_trace") {
    return evidence.selectedTraceId ?? "The selected representative slow trace.";
  }
  if (toolName === "inspect_release") return incident.degradedReleaseId;
  if (toolName === "read_repo_files") {
    const commit = evidence.commitSha?.slice(0, 12) ?? "evidenced commit";
    return `${commit}; ${evidence.sourcePath ?? "the allowlisted changed source"}.`;
  }
  return "Server-bounded evidence input.";
}

function toolResultText(receipt: ProgressReceipt, toolName: string): string {
  const evidence = receipt.evidence;
  if (toolName === "compare_releases") {
    return `Validated ${evidence.baselineReleaseId ?? receipt.incident.baselineReleaseId} against ${evidence.degradedReleaseId ?? receipt.incident.degradedReleaseId}.`;
  }
  if (toolName === "find_slow_traces") {
    return `Selected representative trace ${evidence.selectedTraceId ?? "from the bounded result"}.`;
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
    return `Resolved commit ${commit}${pullRequest}.`;
  }
  if (toolName === "read_repo_files") {
    return `Read ${evidence.sourcePath ?? "the allowlisted source at the evidenced commit"}.`;
  }
  return `Completed ${toolName}.`;
}

export function buildInvestigationEvents(receipt: ProgressReceipt): InvestigationEvent[] {
  const events: InvestigationEvent[] = [];
  for (const phase of receipt.phases) {
    const baseId = `${receipt.investigationId}-${phase.toolName}`;
    const state =
      phase.status === "complete" ? "complete" : phase.status === "pending" ? "active" : "failed";
    events.push({
      id: `${baseId}-reasoning`,
      kind: "reasoning",
      label: "Reasoning summary",
      state,
      text: reasoningText(phase.toolName),
    });
    events.push({
      id: `${baseId}-call`,
      kind: "tool-call",
      label: `Tool call · ${phase.toolName}`,
      state,
      text: toolCallText(receipt, phase.toolName),
    });
    if (phase.status === "complete") {
      events.push({
        id: `${baseId}-result`,
        kind: "tool-result",
        label: `Tool result · ${phase.toolName}`,
        state: "complete",
        text: toolResultText(receipt, phase.toolName),
      });
      continue;
    }
    if (phase.status !== "pending") {
      events.push({
        id: `${baseId}-result`,
        kind: "tool-result",
        label: `Tool result · ${phase.toolName}`,
        state: "failed",
        text: phase.attempts.at(-1)?.reason ?? "Bounded evidence unavailable.",
      });
    }
    break;
  }
  return events;
}

export function InvestigationProgress({ receipt }: { receipt: ProgressReceipt }) {
  const events = buildInvestigationEvents(receipt);
  if (events.length === 0) return null;
  return (
    <Fragment>
      {events.map((event) =>
        event.kind === "reasoning" ? (
          <article
            aria-live="polite"
            className="message assistant activity-message reasoning"
            key={event.id}
          >
            <details>
              <summary>{event.label}</summary>
              <p>{event.text}</p>
            </details>
          </article>
        ) : (
          <article
            aria-live="polite"
            className={`message assistant activity-message ${event.kind} ${event.state}`}
            key={event.id}
          >
            <span>{event.label}</span>
            <p>{event.text}</p>
          </article>
        ),
      )}
    </Fragment>
  );
}
