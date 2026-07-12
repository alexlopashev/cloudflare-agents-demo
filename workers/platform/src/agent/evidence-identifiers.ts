const evidenceId = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

export function findRepresentativeTraceId(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  if (!Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (
      record.operation === "inspect-trace" &&
      typeof record.traceId === "string" &&
      evidenceId.test(record.traceId)
    ) {
      return record.traceId;
    }
  }
  for (const nested of Array.isArray(value) ? value : Object.values(value)) {
    const found = findRepresentativeTraceId(nested);
    if (found !== undefined) return found;
  }
  return undefined;
}
