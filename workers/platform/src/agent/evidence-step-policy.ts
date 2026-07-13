export type RequiredEvidenceTool = "query_telemetry" | "inspect_release" | "read_repo_files";

export type EvidenceStep = {
  toolResults: readonly {
    toolCallId?: string;
    toolName: string;
    input?: unknown;
    output?: unknown;
  }[];
};

type EvidencePhase =
  | "compare-releases"
  | "find-slow-traces"
  | "inspect-trace"
  | "inspect-release"
  | "read-repo-files";

const phaseOrder: readonly EvidencePhase[] = [
  "compare-releases",
  "find-slow-traces",
  "inspect-trace",
  "inspect-release",
  "read-repo-files",
];

const phaseTools: Record<EvidencePhase, RequiredEvidenceTool> = {
  "compare-releases": "query_telemetry",
  "find-slow-traces": "query_telemetry",
  "inspect-trace": "query_telemetry",
  "inspect-release": "inspect_release",
  "read-repo-files": "read_repo_files",
};

function property(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function textContent(message: unknown): string {
  const content = property(message, "content");
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (property(part, "type") === "text" ? property(part, "text") : ""))
    .filter((text): text is string => typeof text === "string")
    .join(" ");
}

export function evidenceInvestigationRequested(messages: readonly unknown[]): boolean {
  const lastUserMessage = messages.findLast((message) => property(message, "role") === "user");
  return lastUserMessage !== undefined && messageRequestsInvestigation(lastUserMessage);
}

function messageRequestsInvestigation(message: unknown): boolean {
  return /\b(?:investigat\w*|latency|regression|root cause|slow(?:down|er|ness)?)\b/i.test(
    textContent(message),
  );
}

export function messagesForCurrentInvestigation(messages: readonly unknown[]): readonly unknown[] {
  const start = messages.findLastIndex(
    (message) => property(message, "role") === "user" && messageRequestsInvestigation(message),
  );
  return start < 0 ? messages : messages.slice(start);
}

function unwrapModelToolOutput(output: unknown): unknown {
  const type = property(output, "type");
  if (type === "json" || type === "text") return property(output, "value");
  if (type === "error-json" || type === "error-text" || type === "execution-denied") {
    return { status: "error", code: "unavailable", message: property(output, "value") };
  }
  return output;
}

export function evidenceStepsFromModelMessages(messages: readonly unknown[]): EvidenceStep[] {
  const calls = new Map<string, { input: unknown; toolName: string }>();
  const toolResults: EvidenceStep["toolResults"][number][] = [];
  for (const message of messages) {
    const content = property(message, "content");
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      const type = property(part, "type");
      const toolCallId = property(part, "toolCallId");
      const toolName = property(part, "toolName");
      if (type === "tool-call" && typeof toolCallId === "string" && typeof toolName === "string") {
        calls.set(toolCallId, { input: property(part, "input"), toolName });
        continue;
      }
      if (type !== "tool-result" || typeof toolCallId !== "string") continue;
      const call = calls.get(toolCallId);
      const resolvedToolName = typeof toolName === "string" ? toolName : call?.toolName;
      if (resolvedToolName === undefined) continue;
      toolResults.push({
        toolCallId,
        toolName: resolvedToolName,
        input: call?.input ?? property(part, "input"),
        output: unwrapModelToolOutput(property(part, "output")),
      });
    }
  }
  return toolResults.length === 0 ? [] : [{ toolResults }];
}

function phaseOf(toolName: string, input: unknown): EvidencePhase | undefined {
  if (toolName === "inspect_release") return "inspect-release";
  if (toolName === "read_repo_files") return "read-repo-files";
  if (toolName !== "query_telemetry") return undefined;
  const operation = property(input, "operation");
  return phaseOrder.find((phase) => phase === operation);
}

function succeeded(output: unknown): boolean {
  return property(output, "status") !== "error";
}

export function nextRequiredEvidenceTool(
  steps: readonly EvidenceStep[],
): RequiredEvidenceTool | undefined {
  const attempts = new Map<EvidencePhase, number>();
  const completed = new Set<EvidencePhase>();
  const seenToolCalls = new Set<string>();
  for (const step of steps) {
    for (const result of step.toolResults) {
      if (result.toolCallId !== undefined) {
        if (seenToolCalls.has(result.toolCallId)) continue;
        seenToolCalls.add(result.toolCallId);
      }
      const phase = phaseOf(result.toolName, result.input);
      if (phase === undefined) continue;
      attempts.set(phase, (attempts.get(phase) ?? 0) + 1);
      if (succeeded(result.output)) completed.add(phase);
    }
  }

  if (attempts.size === 0) return undefined;
  for (const phase of phaseOrder) {
    if (completed.has(phase)) continue;
    return (attempts.get(phase) ?? 0) < 2 ? phaseTools[phase] : undefined;
  }
  return undefined;
}
