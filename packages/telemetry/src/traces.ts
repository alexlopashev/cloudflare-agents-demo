export type TraceSpan = {
  spanId: string;
  parentSpanId: string | null;
  serviceId: string;
  startedAtMs: number;
  durationMs: number;
  status: "ok" | "error";
};

export type TraceNode = {
  span: TraceSpan;
  children: TraceNode[];
  missingParentSpanId?: string;
};

function validateSpan(span: TraceSpan) {
  if (
    span.spanId.length === 0 ||
    span.spanId.length > 128 ||
    span.serviceId.length === 0 ||
    span.serviceId.length > 128 ||
    !Number.isFinite(span.startedAtMs) ||
    span.startedAtMs < 0 ||
    !Number.isFinite(span.durationMs) ||
    span.durationMs < 0 ||
    (span.parentSpanId !== null &&
      (span.parentSpanId.length === 0 || span.parentSpanId.length > 128))
  ) {
    throw new TypeError("Trace span is invalid.");
  }
}

function indexSpans(spans: readonly TraceSpan[]): Map<string, TraceSpan> {
  const byId = new Map<string, TraceSpan>();
  for (const span of spans) {
    validateSpan(span);
    if (byId.has(span.spanId)) throw new TypeError("Trace span identifiers must be unique.");
    byId.set(span.spanId, span);
  }
  return byId;
}

function compareSpans(left: TraceSpan, right: TraceSpan): number {
  return left.startedAtMs - right.startedAtMs || left.spanId.localeCompare(right.spanId);
}

export function buildTraceForest(spans: readonly TraceSpan[]): TraceNode[] {
  const byId = indexSpans(spans);
  const visits = new Map<string, "visiting" | "visited">();
  const visit = (span: TraceSpan) => {
    const state = visits.get(span.spanId);
    if (state === "visiting") throw new TypeError("Trace parentage contains a cycle.");
    if (state === "visited") return;
    visits.set(span.spanId, "visiting");
    const parent = span.parentSpanId === null ? undefined : byId.get(span.parentSpanId);
    if (parent) visit(parent);
    visits.set(span.spanId, "visited");
  };
  for (const span of spans) visit(span);

  const nodes = new Map<string, TraceNode>();
  for (const span of spans) nodes.set(span.spanId, { span, children: [] });
  const roots: TraceNode[] = [];
  for (const span of spans) {
    const node = nodes.get(span.spanId);
    if (!node) throw new TypeError("Trace node index is inconsistent.");
    const parent = span.parentSpanId === null ? undefined : nodes.get(span.parentSpanId);
    if (parent) {
      parent.children.push(node);
    } else {
      if (span.parentSpanId !== null) node.missingParentSpanId = span.parentSpanId;
      roots.push(node);
    }
  }
  const sortTree = (node: TraceNode) => {
    node.children.sort((left, right) => compareSpans(left.span, right.span));
    for (const child of node.children) sortTree(child);
  };
  roots.sort((left, right) => compareSpans(left.span, right.span));
  for (const root of roots) sortTree(root);
  return roots;
}

export function calculateCriticalPath(spans: readonly TraceSpan[]) {
  indexSpans(spans);
  if (spans.length === 0) return { durationMs: 0, spanIds: [] as string[] };
  const sorted = [...spans].sort(compareSpans);
  let durationMs = 0;
  let intervalStart = sorted[0]?.startedAtMs ?? 0;
  let intervalEnd = intervalStart + (sorted[0]?.durationMs ?? 0);
  for (const span of sorted.slice(1)) {
    const end = span.startedAtMs + span.durationMs;
    if (span.startedAtMs > intervalEnd) {
      durationMs += intervalEnd - intervalStart;
      intervalStart = span.startedAtMs;
      intervalEnd = end;
    } else {
      intervalEnd = Math.max(intervalEnd, end);
    }
  }
  durationMs += intervalEnd - intervalStart;
  return { durationMs, spanIds: sorted.map((span) => span.spanId) };
}
