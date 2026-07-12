export type ToolTimelineEntry = {
  id: string;
  label: string;
  state: "running" | "completed" | "failed";
  summary: string;
};

type TimelineMessage = { id: string; parts: readonly unknown[] };

const labels: Record<string, string> = {
  query_telemetry: "Query telemetry",
  inspect_release: "Inspect release",
  read_repo_files: "Read repository files",
  create_draft_pr: "Create draft PR",
};

function stringProperty(value: object, property: string): string | undefined {
  const candidate = Reflect.get(value, property);
  return typeof candidate === "string" ? candidate : undefined;
}

export function buildToolTimeline(messages: readonly TimelineMessage[]): ToolTimelineEntry[] {
  const entries: ToolTimelineEntry[] = [];
  for (const message of messages) {
    for (const [index, part] of message.parts.entries()) {
      if (part === null || typeof part !== "object") continue;
      const type = stringProperty(part, "type");
      if (type === undefined || !type.startsWith("tool-")) continue;
      const toolName = type.slice("tool-".length);
      if (!(toolName in labels)) continue;
      const state = stringProperty(part, "state");
      const output = Reflect.get(part, "output");
      const outputStatus =
        output !== null && typeof output === "object"
          ? stringProperty(output, "status")
          : undefined;
      const failed = state === "output-error" || outputStatus === "error";
      const completed = state === "output-available" && !failed;
      entries.push({
        id: `${message.id}-${stringProperty(part, "toolCallId") ?? index}`,
        label: labels[toolName] ?? toolName,
        state: failed ? "failed" : completed ? "completed" : "running",
        summary: failed
          ? "Evidence lookup failed"
          : state === "approval-requested"
            ? "Awaiting human approval"
            : outputStatus === "truncated"
              ? "Evidence received (truncated to context limit)"
              : completed
                ? "Evidence received"
                : "Gathering evidence",
      });
    }
  }
  return entries;
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
