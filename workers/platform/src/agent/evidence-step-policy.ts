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

function messageRequestsInvestigation(message: unknown): boolean {
  return /\b(?:investigat\w*|latency|regression|root cause|slow(?:down|er|ness)?)\b/i.test(
    textContent(message),
  );
}

export function evidenceInvestigationRequested(messages: readonly unknown[]): boolean {
  const lastUserMessage = messages.findLast((message) => property(message, "role") === "user");
  return lastUserMessage !== undefined && messageRequestsInvestigation(lastUserMessage);
}

export function remediationPreviewRequested(messages: readonly unknown[]): boolean {
  const lastUserMessage = messages.findLast((message) => property(message, "role") === "user");
  return (
    lastUserMessage !== undefined &&
    /\bprepare the guarded remediation preview\b/i.test(textContent(lastUserMessage))
  );
}

export function messagesForCurrentInvestigation(messages: readonly unknown[]): readonly unknown[] {
  const start = messages.findLastIndex(
    (message) => property(message, "role") === "user" && messageRequestsInvestigation(message),
  );
  return start < 0 ? messages : messages.slice(start);
}
