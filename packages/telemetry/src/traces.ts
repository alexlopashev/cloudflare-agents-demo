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
  cyclicParentSpanId?: string;
};

export type TraceParentageDiagnostic =
  | { code: "cycle"; spanIds: string[] }
  | { code: "missing-parent"; spanId: string; parentSpanId: string };

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

function analyzeParentage(byId: ReadonlyMap<string, TraceSpan>): {
  cyclicIds: ReadonlySet<string>;
  diagnostics: TraceParentageDiagnostic[];
} {
  const cyclicIds = new Set<string>();
  const cycles = new Map<string, string[]>();
  const states = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const positions = new Map<string, number>();

  const visit = (spanId: string) => {
    const state = states.get(spanId);
    if (state === "visited") return;
    if (state === "visiting") {
      const start = positions.get(spanId);
      if (start === undefined) throw new TypeError("Trace parentage index is inconsistent.");
      const spanIds = stack.slice(start).sort((left, right) => left.localeCompare(right));
      for (const id of spanIds) cyclicIds.add(id);
      cycles.set(spanIds.join("\0"), spanIds);
      return;
    }

    states.set(spanId, "visiting");
    positions.set(spanId, stack.length);
    stack.push(spanId);
    const parentSpanId = byId.get(spanId)?.parentSpanId;
    if (parentSpanId !== null && parentSpanId !== undefined && byId.has(parentSpanId)) {
      visit(parentSpanId);
    }
    stack.pop();
    positions.delete(spanId);
    states.set(spanId, "visited");
  };

  for (const spanId of [...byId.keys()].sort((left, right) => left.localeCompare(right))) {
    visit(spanId);
  }

  const diagnostics: TraceParentageDiagnostic[] = [...cycles.values()]
    .sort((left, right) => (left[0] ?? "").localeCompare(right[0] ?? ""))
    .map((spanIds) => ({ code: "cycle", spanIds }));
  const missing = [...byId.values()]
    .filter(
      (span): span is TraceSpan & { parentSpanId: string } =>
        span.parentSpanId !== null && !byId.has(span.parentSpanId),
    )
    .sort((left, right) => left.spanId.localeCompare(right.spanId));
  diagnostics.push(
    ...missing.map((span) => ({
      code: "missing-parent" as const,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
    })),
  );
  return { cyclicIds, diagnostics };
}

export function buildTraceForest(spans: readonly TraceSpan[]): TraceNode[] {
  const byId = indexSpans(spans);
  const { cyclicIds } = analyzeParentage(byId);

  const nodes = new Map<string, TraceNode>();
  for (const span of spans) nodes.set(span.spanId, { span, children: [] });
  const roots: TraceNode[] = [];
  for (const span of spans) {
    const node = nodes.get(span.spanId);
    if (!node) throw new TypeError("Trace node index is inconsistent.");
    if (cyclicIds.has(span.spanId)) {
      if (span.parentSpanId === null) throw new TypeError("Cyclic parentage is inconsistent.");
      node.cyclicParentSpanId = span.parentSpanId;
      roots.push(node);
      continue;
    }
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

type BranchPlan = {
  spanIds: string[];
  startedAtMs: number;
  endedAtMs: number;
  scoreMs: number;
};

type Schedule = {
  branches: BranchPlan[];
  scoreMs: number;
};

function scheduleKey(schedule: Schedule): string {
  return schedule.branches.flatMap((branch) => branch.spanIds).join("\0");
}

function preferredSchedule(left: Schedule, right: Schedule): Schedule {
  if (left.scoreMs !== right.scoreMs) return left.scoreMs > right.scoreMs ? left : right;
  if (left.branches.length === 0 && right.branches.length > 0) return right;
  if (right.branches.length === 0 && left.branches.length > 0) return left;
  return scheduleKey(left).localeCompare(scheduleKey(right)) <= 0 ? left : right;
}

function selectSequentialBranches(branches: readonly BranchPlan[]): Schedule {
  const sorted = [...branches].sort(
    (left, right) =>
      left.endedAtMs - right.endedAtMs ||
      left.startedAtMs - right.startedAtMs ||
      (left.spanIds[0] ?? "").localeCompare(right.spanIds[0] ?? ""),
  );
  const schedules: Schedule[] = [{ branches: [], scoreMs: 0 }];
  for (const [index, branch] of sorted.entries()) {
    let compatibleCount = index;
    while (
      compatibleCount > 0 &&
      (sorted[compatibleCount - 1]?.endedAtMs ?? Number.POSITIVE_INFINITY) > branch.startedAtMs
    ) {
      compatibleCount -= 1;
    }
    const previous = schedules[index] ?? { branches: [], scoreMs: 0 };
    const compatible = schedules[compatibleCount] ?? { branches: [], scoreMs: 0 };
    const selected = {
      branches: [...compatible.branches, branch],
      scoreMs: compatible.scoreMs + branch.scoreMs,
    };
    schedules.push(preferredSchedule(previous, selected));
  }
  return schedules.at(-1) ?? { branches: [], scoreMs: 0 };
}

export function calculateCriticalPath(spans: readonly TraceSpan[]) {
  const byId = indexSpans(spans);
  const { cyclicIds, diagnostics } = analyzeParentage(byId);
  const children = new Map<string, TraceSpan[]>();
  for (const span of spans) {
    if (span.parentSpanId === null || cyclicIds.has(span.spanId)) continue;
    const siblings = children.get(span.parentSpanId) ?? [];
    siblings.push(span);
    children.set(span.parentSpanId, siblings);
  }

  const buildBranch = (span: TraceSpan): BranchPlan => {
    const childPlans = (children.get(span.spanId) ?? []).map(buildBranch);
    const selectedChildren = selectSequentialBranches(childPlans);
    return {
      spanIds: [span.spanId, ...selectedChildren.branches.flatMap((branch) => branch.spanIds)],
      startedAtMs: span.startedAtMs,
      endedAtMs: span.startedAtMs + span.durationMs,
      scoreMs: span.durationMs,
    };
  };

  const rootPlans = spans
    .filter((span) => span.parentSpanId === null && !cyclicIds.has(span.spanId))
    .map(buildBranch);
  const selected = selectSequentialBranches(rootPlans).branches;
  if (selected.length === 0) return { diagnostics, spanIds: [] as string[], wallTimeMs: 0 };
  const startedAtMs = Math.min(...selected.map((branch) => branch.startedAtMs));
  const endedAtMs = Math.max(...selected.map((branch) => branch.endedAtMs));
  return {
    diagnostics,
    spanIds: selected.flatMap((branch) => branch.spanIds),
    wallTimeMs: endedAtMs - startedAtMs,
  };
}
