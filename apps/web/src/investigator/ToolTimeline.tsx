export type ToolTimelineEntry = {
  id: string;
  label: string;
  state: "running" | "completed" | "failed";
  summary: string;
};

type ReceiptPhase = {
  toolName: string;
  status: "pending" | "complete" | "insufficient" | "error";
};

type TimelineReceipt = {
  investigationId: string;
  phases: readonly ReceiptPhase[];
};

const labels: Record<string, string> = {
  compare_releases: "Compare releases",
  find_slow_traces: "Find slow traces",
  inspect_trace: "Inspect trace",
  inspect_release: "Inspect release",
  read_repo_files: "Read repository files",
};

export function buildToolTimeline(receipt: TimelineReceipt): ToolTimelineEntry[] {
  const activeIndex = receipt.phases.findIndex((phase) => phase.status !== "complete");
  return receipt.phases.map((phase, index) => ({
    id: `${receipt.investigationId}-${phase.toolName}`,
    label: labels[phase.toolName] ?? phase.toolName,
    state:
      phase.status === "complete" ? "completed" : phase.status === "pending" ? "running" : "failed",
    summary:
      phase.status === "complete"
        ? "Evidence received"
        : phase.status === "insufficient"
          ? "Evidence incomplete (bounded result)"
          : phase.status === "error"
            ? "Evidence lookup failed"
            : index === activeIndex
              ? "Gathering evidence"
              : "Waiting for prior evidence",
  }));
}

export function ToolTimeline({ entries }: { entries: readonly ToolTimelineEntry[] }) {
  if (entries.length === 0) return null;
  return (
    <section className="tool-timeline">
      <p className="eyebrow">Evidence timeline</p>
      <ol aria-label="Investigation tool timeline">
        {entries.map((entry) => (
          <li className={entry.state} key={entry.id}>
            <span className="tool-timeline-label">{entry.label}</span>
            <small>{entry.summary}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}
