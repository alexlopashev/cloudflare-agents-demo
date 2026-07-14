import { z } from "zod";

import {
  evidenceErrorCodes,
  evidenceToolNames,
  type EvidenceToolName,
} from "../../../../packages/contracts/src/evidence";
import {
  parseIncidentReference,
  type IncidentReference,
} from "../../../../packages/contracts/src/incident";
import { configuredComparisonWindowMs } from "./evidence-policy";

export {
  evidenceErrorCodes,
  evidenceToolNames,
  type EvidenceToolName,
} from "../../../../packages/contracts/src/evidence";
export type EvidenceResultStatus = "complete" | "insufficient" | "error";

export type EvidenceToolResult = {
  toolCallId?: string;
  toolName: string;
  input?: unknown;
  output?: unknown;
};

export type EvidencePhaseReceipt = {
  toolName: EvidenceToolName;
  status: "pending" | EvidenceResultStatus;
  attempts: readonly {
    toolCallId?: string;
    status: EvidenceResultStatus;
    reason: string;
  }[];
};

export type EvidenceReceipt = {
  investigationId: string;
  incident: IncidentReference;
  phases: readonly EvidencePhaseReceipt[];
  processedToolCallIds: readonly string[];
  evidence: {
    baselineReleaseId?: string;
    degradedReleaseId?: string;
    selectedTraceId?: string;
    inspectedTraceId?: string;
    releaseId?: string;
    commitSha?: string;
    pullRequest?:
      | { status: "found"; number: number }
      | { status: "unknown"; reason: "not-found" | "ambiguous" };
    sourcePath?: string;
    blobSha?: string;
    sourceContent?: string;
  };
};

const evidenceId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const immutableSha = z.string().regex(/^[0-9a-f]{40}$/);
const configuredRemediationSourcePath = "workers/platform/src/api/health.ts";
const safePath = z
  .string()
  .min(1)
  .max(512)
  .refine((path) => !path.startsWith("/") && !path.split("/").includes(".."));
const metricSummary = z
  .object({
    count: z.number().int().positive(),
    p50Ms: z.number().nonnegative(),
    p75Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    errorRate: z.number().min(0).max(1),
  })
  .passthrough();
const comparisonOutput = z
  .object({
    status: z.literal("ready"),
    windowMs: z.number().int().positive(),
    baseline: metricSummary,
    candidate: metricSummary,
    delta: z.object({ p75Ms: z.number() }).passthrough(),
  })
  .passthrough();
const traceRecord = z
  .object({
    traceId: evidenceId,
    interactionId: evidenceId,
    releaseId: evidenceId,
    startedAtMs: z.number().int().nonnegative(),
    durationMs: z.number().nonnegative(),
    outcome: z.enum(["success", "partial", "error"]),
  })
  .passthrough();
const slowTraceOutput = z.array(traceRecord).min(1).max(100);
const traceParentageDiagnostic = z.discriminatedUnion("code", [
  z.object({ code: z.literal("cycle"), spanIds: z.array(evidenceId).min(1).max(500) }).strict(),
  z
    .object({
      code: z.literal("missing-parent"),
      spanId: evidenceId,
      parentSpanId: evidenceId,
    })
    .strict(),
]);
const traceOutput = z
  .object({
    trace: traceRecord,
    criticalPath: z
      .object({
        wallTimeMs: z.number().nonnegative(),
        spanIds: z.array(evidenceId).min(1),
        diagnostics: z.array(traceParentageDiagnostic).max(500),
      })
      .passthrough(),
    tree: z.array(z.unknown()).min(1),
  })
  .passthrough();
const pullRequestEvidence = z.discriminatedUnion("status", [
  z.object({ status: z.literal("found"), number: z.number().int().positive() }).passthrough(),
  z
    .object({
      status: z.literal("unknown"),
      reason: z.enum(["not-found", "ambiguous"]),
    })
    .passthrough(),
]);
const releaseOutput = z
  .object({
    release: z.object({ versionId: evidenceId, commitSha: immutableSha }).passthrough(),
    commit: z
      .object({
        sha: immutableSha,
        changes: z.array(z.object({ path: safePath }).passthrough()).min(1),
      })
      .passthrough(),
    pullRequest: pullRequestEvidence,
  })
  .passthrough();
const sourceOutput = z
  .array(
    z
      .object({
        path: safePath,
        blobSha: immutableSha,
        byteLength: z.number().int().positive(),
        content: z.string().min(1),
      })
      .passthrough(),
  )
  .length(1);

function property(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null ? Reflect.get(value, name) : undefined;
}

function unwrapModelToolOutput(output: unknown): unknown {
  const type = property(output, "type");
  if (type === "json" || type === "text") return property(output, "value");
  if (type === "error-json" || type === "error-text" || type === "execution-denied") {
    return { status: "error", code: "unavailable" };
  }
  return output;
}

export function evidenceResultsFromModelMessages(
  messages: readonly unknown[],
): EvidenceToolResult[] {
  const calls = new Map<string, { input: unknown; toolName: string }>();
  const results: EvidenceToolResult[] = [];
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
      results.push({
        toolCallId,
        toolName: resolvedToolName,
        input: call?.input ?? property(part, "input"),
        output: unwrapModelToolOutput(property(part, "output")),
      });
    }
  }
  return results;
}

export function createEvidenceReceipt(
  investigationId: string,
  incidentReference: IncidentReference,
): EvidenceReceipt {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(investigationId)) {
    throw new TypeError("Investigation identifier is invalid.");
  }
  return {
    investigationId,
    incident: parseIncidentReference(incidentReference),
    phases: evidenceToolNames.map((toolName) => ({
      toolName,
      status: "pending" as const,
      attempts: [],
    })),
    processedToolCallIds: [],
    evidence: {},
  };
}

function resultClassification(output: unknown): Validation | undefined {
  if (property(output, "status") === "error") {
    const code = z.enum(evidenceErrorCodes).safeParse(property(output, "code"));
    return { status: "error", reason: code.success ? code.data : "unavailable" };
  }
  if (
    output === null ||
    output === undefined ||
    property(output, "status") === "truncated" ||
    property(output, "status") === "insufficient-data" ||
    (Array.isArray(output) && output.length === 0)
  ) {
    return { status: "insufficient", reason: "insufficient" };
  }
  return undefined;
}

type Validation = {
  status: EvidenceResultStatus;
  reason: string;
  evidence?: EvidenceReceipt["evidence"];
};

function validateExpectedResult(receipt: EvidenceReceipt, result: EvidenceToolResult): Validation {
  const classified = resultClassification(result.output);
  if (classified !== undefined) return classified;
  const incident = receipt.incident;

  if (result.toolName === "compare_releases") {
    const input = z
      .object({
        baselineReleaseId: evidenceId,
        candidateReleaseId: evidenceId,
        windowMs: z.number().int().positive(),
      })
      .partial()
      .strict()
      .safeParse(result.input);
    const output = comparisonOutput.safeParse(result.output);
    if (
      !input.success ||
      !output.success ||
      output.data.windowMs !== configuredComparisonWindowMs
    ) {
      return { status: "insufficient", reason: "invalid-or-mismatched-comparison" };
    }
    return {
      status: "complete",
      reason: "validated",
      evidence: {
        baselineReleaseId: incident.baselineReleaseId,
        degradedReleaseId: incident.degradedReleaseId,
      },
    };
  }

  if (result.toolName === "find_slow_traces") {
    const input = z
      .object({
        releaseId: evidenceId,
        sinceMs: z.number().int().nonnegative(),
        untilMs: z.number().int().positive(),
        limit: z.number().int().min(1).max(100),
      })
      .partial()
      .strict()
      .safeParse(result.input);
    const output = slowTraceOutput.safeParse(result.output);
    if (
      !input.success ||
      !output.success ||
      output.data.some(
        (trace) =>
          trace.releaseId !== incident.degradedReleaseId ||
          trace.startedAtMs < incident.traceWindow.sinceMs ||
          trace.startedAtMs >= incident.traceWindow.untilMs,
      )
    ) {
      return { status: "insufficient", reason: "invalid-or-mismatched-trace-search" };
    }
    const selected = output.data[0];
    if (selected === undefined) return { status: "insufficient", reason: "empty-trace-search" };
    return {
      status: "complete",
      reason: "validated",
      evidence: { selectedTraceId: selected.traceId },
    };
  }

  if (result.toolName === "inspect_trace") {
    const input = z.object({ traceId: evidenceId.optional() }).strict().safeParse(result.input);
    const output = traceOutput.safeParse(result.output);
    if (
      !input.success ||
      !output.success ||
      output.data.trace.traceId !== receipt.evidence.selectedTraceId ||
      output.data.trace.releaseId !== incident.degradedReleaseId
    ) {
      return { status: "insufficient", reason: "invalid-or-mismatched-trace-detail" };
    }
    return {
      status: "complete",
      reason: "validated",
      evidence: { inspectedTraceId: output.data.trace.traceId },
    };
  }

  if (result.toolName === "inspect_release") {
    const input = z.object({ versionId: evidenceId.optional() }).strict().safeParse(result.input);
    const output = releaseOutput.safeParse(result.output);
    if (
      !input.success ||
      !output.success ||
      output.data.release.versionId !== incident.degradedReleaseId ||
      output.data.release.commitSha !== output.data.commit.sha
    ) {
      return { status: "insufficient", reason: "invalid-or-mismatched-release" };
    }
    const configuredChange = output.data.commit.changes.find(
      (change) => change.path === configuredRemediationSourcePath,
    );
    if (configuredChange === undefined) {
      return { status: "insufficient", reason: "missing-configured-source-change" };
    }
    return {
      status: "complete",
      reason: "validated",
      evidence: {
        releaseId: output.data.release.versionId,
        commitSha: output.data.commit.sha,
        pullRequest: output.data.pullRequest,
        sourcePath: configuredChange.path,
      },
    };
  }

  const input = z
    .object({ commitSha: immutableSha, paths: z.array(safePath).length(1) })
    .strict()
    .safeParse(result.input);
  const output = sourceOutput.safeParse(result.output);
  const file = output.success ? output.data[0] : undefined;
  if (
    !input.success ||
    file === undefined ||
    input.data.commitSha !== receipt.evidence.commitSha ||
    input.data.paths[0] !== receipt.evidence.sourcePath ||
    file.path !== input.data.paths[0]
  ) {
    return { status: "insufficient", reason: "invalid-or-mismatched-source" };
  }
  return {
    status: "complete",
    reason: "validated",
    evidence: { sourcePath: file.path, blobSha: file.blobSha, sourceContent: file.content },
  };
}

export function recordEvidenceResult(
  receipt: EvidenceReceipt,
  result: EvidenceToolResult,
): EvidenceReceipt {
  const toolIndex = (evidenceToolNames as readonly string[]).indexOf(result.toolName);
  if (toolIndex < 0) return receipt;
  if (result.toolCallId !== undefined && receipt.processedToolCallIds.includes(result.toolCallId)) {
    return receipt;
  }
  if (receipt.phases[toolIndex]?.status === "complete") return receipt;
  if ((receipt.phases[toolIndex]?.attempts.length ?? 0) >= 2) return receipt;

  const expectedIndex = receipt.phases.findIndex((phase) => phase.status !== "complete");
  const validation =
    toolIndex === expectedIndex
      ? validateExpectedResult(receipt, result)
      : { status: "insufficient" as const, reason: "phase-out-of-order" };
  const phases = receipt.phases.map((phase, index) =>
    index === toolIndex
      ? {
          ...phase,
          status: validation.status,
          attempts: [
            ...phase.attempts,
            {
              ...(result.toolCallId === undefined ? {} : { toolCallId: result.toolCallId }),
              status: validation.status,
              reason: validation.reason,
            },
          ],
        }
      : phase,
  );
  return {
    ...receipt,
    phases,
    processedToolCallIds:
      result.toolCallId === undefined
        ? receipt.processedToolCallIds
        : [...receipt.processedToolCallIds, result.toolCallId],
    evidence:
      validation.status === "complete"
        ? { ...receipt.evidence, ...validation.evidence }
        : receipt.evidence,
  };
}

export function nextEvidenceTool(receipt: EvidenceReceipt): EvidenceToolName | undefined {
  const phase = receipt.phases.find((candidate) => candidate.status !== "complete");
  return phase !== undefined && phase.attempts.length < 2 ? phase.toolName : undefined;
}

export function evidenceReceiptComplete(receipt: EvidenceReceipt): boolean {
  return receipt.phases.every((phase) => phase.status === "complete");
}
