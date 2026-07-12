import type { LanguageModel } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createWorkersAI } from "workers-ai-provider";

import { remediationFixture } from "../../../../packages/test-fixtures/src/remediation";
import { regressionSource } from "../../../../packages/test-fixtures/src/scenario";

export const WORKERS_AI_MODEL = "@cf/moonshotai/kimi-k2.6";

export interface ModelEnvironment<TBinding = Ai> {
  AI?: TBinding;
  MODEL_MODE: string;
}

export interface ModelFactories<T, TBinding = Ai> {
  fake(): T;
  workersAI(binding: TBinding, modelId: string): T;
}

export function selectAgentModel<T, TBinding>(
  environment: ModelEnvironment<TBinding>,
  factories: ModelFactories<T, TBinding>,
): T {
  if (environment.MODEL_MODE === "fake") return factories.fake();

  if (environment.MODEL_MODE === "workers-ai") {
    if (!environment.AI) throw new Error("Workers AI mode requires the AI binding.");
    return factories.workersAI(environment.AI, WORKERS_AI_MODEL);
  }

  throw new Error(`Unsupported model mode: ${environment.MODEL_MODE}`);
}

export function createDeterministicModel(): LanguageModel {
  let step = 0;
  const usage = {
    inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 3, text: 3, reasoning: undefined },
  };
  const findProperty = (value: unknown, property: string): string | undefined => {
    let found: string | undefined;
    const visit = (candidate: unknown) => {
      if (found !== undefined || candidate === null || typeof candidate !== "object") return;
      if (!Array.isArray(candidate)) {
        const record = candidate as Record<string, unknown>;
        if (typeof record[property] === "string") {
          found = record[property];
          return;
        }
      }
      for (const nested of Array.isArray(candidate)
        ? candidate
        : Object.values(candidate as Record<string, unknown>)) {
        visit(nested);
      }
    };
    visit(value);
    return found;
  };
  const findNestedNumber = (
    value: unknown,
    containerProperty: string,
    numberProperty: string,
  ): number | undefined => {
    let found: number | undefined;
    const visit = (candidate: unknown) => {
      if (found !== undefined || candidate === null || typeof candidate !== "object") return;
      if (!Array.isArray(candidate)) {
        const record = candidate as Record<string, unknown>;
        const container = record[containerProperty];
        if (container !== null && typeof container === "object" && !Array.isArray(container)) {
          const number = (container as Record<string, unknown>)[numberProperty];
          if (typeof number === "number" && Number.isFinite(number)) {
            found = number;
            return;
          }
        }
      }
      for (const nested of Array.isArray(candidate)
        ? candidate
        : Object.values(candidate as Record<string, unknown>)) {
        visit(nested);
      }
    };
    visit(value);
    return found;
  };
  const next = (prompt: unknown) => {
    const serializedPrompt = JSON.stringify(prompt);
    const remediationRequested = serializedPrompt
      .toLowerCase()
      .includes("prepare the guarded remediation preview");
    if (remediationRequested) {
      if (serializedPrompt.includes('"status":"preview"')) {
        return {
          type: "text" as const,
          text: `## Remediation
The guarded change passed repository, path, SHA, blob, byte, line, and changed-line validation.

## Result
A validated preview is ready. No GitHub write occurred because writes are disabled in this mode.

## Safety
The preview grants no merge, deployment, or rollback capability.`,
        };
      }
      if (
        serializedPrompt.includes('"status":"created"') ||
        serializedPrompt.includes('"status":"reused"')
      ) {
        return {
          type: "text" as const,
          text: `## Remediation
The guarded draft pull request was created or safely reused after explicit approval.

## Safety
No merge, deployment, or rollback capability was granted.`,
        };
      }
      if (serializedPrompt.includes('"status":"recoverable"')) {
        return {
          type: "text" as const,
          text: `## Remediation
GitHub returned a recoverable partial state on the deterministic incident branch. Retry the same
approved action to reconcile or create the draft pull request without creating another branch.`,
        };
      }
      const evidencePresent =
        serializedPrompt.includes("## Evidence") &&
        serializedPrompt.includes(regressionSource.commitSha) &&
        serializedPrompt.includes(`PR #${regressionSource.pullRequestNumber}`);
      if (!evidencePresent) {
        return {
          type: "text" as const,
          text: "Remediation refused: trace, release, commit, and pull-request evidence are required first.",
        };
      }
      const reportTrace =
        /Representative trace: ([A-Za-z0-9_-]+)/.exec(serializedPrompt)?.[1] ??
        remediationFixture.incident.traceId;
      const proposal = {
        ...remediationFixture,
        incident: { ...remediationFixture.incident, traceId: reportTrace },
        expectedBlobSha: findProperty(prompt, "blobSha") ?? remediationFixture.expectedBlobSha,
      };
      step += 1;
      return { type: "tool" as const, toolName: "create_draft_pr" as const, input: proposal };
    }

    const traceId = findProperty(prompt, "traceId") ?? "regression-trace-unknown";
    const sequence = [
      {
        toolName: "query_telemetry",
        input: {
          operation: "compare-releases",
          baselineReleaseId: "baseline-concurrent",
          candidateReleaseId: "regression-sequential",
          windowMs: 60_000,
        },
      },
      {
        toolName: "query_telemetry",
        input: {
          operation: "find-slow-traces",
          releaseId: "regression-sequential",
          sinceMs: 1_700_086_400_000,
          untilMs: 1_700_086_460_000,
          limit: 5,
        },
      },
      {
        toolName: "query_telemetry",
        input: { operation: "inspect-trace", traceId },
      },
      {
        toolName: "inspect_release",
        input: { versionId: "regression-sequential" },
      },
      {
        toolName: "read_repo_files",
        input: {
          commitSha: regressionSource.commitSha,
          paths: ["workers/platform/src/api/health.ts"],
        },
      },
    ] as const;
    const toolCall = sequence[step];
    step += 1;
    if (toolCall !== undefined) return { type: "tool" as const, ...toolCall };
    if (serializedPrompt.includes('"status":"error"')) {
      return {
        type: "text" as const,
        text: `## Evidence
One or more evidence tools returned a bounded unavailable error. The required trace, release,
commit, pull-request, and source chain is incomplete.

## Inference
No causal conclusion or fix proposal is justified from the available evidence.

## Confidence
Low. A required evidence source failed during this turn.

## Unknowns
The degraded critical path and immutable source change remain unknown. Retry the failed bounded
evidence operation before remediation. No write or deployment has been performed.`,
      };
    }
    const baselineP75 = findNestedNumber(prompt, "baseline", "p75Ms") ?? "unknown";
    const candidateP75 = findNestedNumber(prompt, "candidate", "p75Ms") ?? "unknown";
    const criticalPathMs = findNestedNumber(prompt, "criticalPath", "durationMs") ?? "unknown";
    const latencyRatio =
      typeof baselineP75 === "number" && typeof candidateP75 === "number" && baselineP75 > 0
        ? (candidateP75 / baselineP75).toFixed(1)
        : "unknown";
    return {
      type: "text" as const,
      text: `## Evidence
- Release comparison: baseline-concurrent p75 ${baselineP75} ms; regression-sequential p75 ${candidateP75} ms.
- Representative trace: ${traceId}; its critical path is approximately ${criticalPathMs} ms with sequential service spans.
- Immutable source: commit ${regressionSource.commitSha}; PR #${regressionSource.pullRequestNumber}.
- Source at that commit awaits each service check when loadingMode is sequential.

## Inference
The sequential health-loading change is the likely cause of the roughly ${latencyRatio}x latency increase. A
bounded-concurrency repair should preserve the stated downstream-pressure intent while removing the
fully serialized critical path.

## Confidence
High. The measured release delta, trace timing, immutable commit, source PR, and pinned source agree.

## Unknowns
The optimal concurrency bound still requires downstream capacity validation. No write or deployment
has been performed.`,
    };
  };
  return new MockLanguageModelV3({
    modelId: "regression-surgeon-deterministic",
    doGenerate: async () => ({
      content: [
        {
          type: "text",
          text: "Evidence is required through the deterministic streaming investigation path.",
        },
      ],
      finishReason: { unified: "stop", raw: undefined },
      usage,
      warnings: [],
    }),
    doStream: async (options) => {
      const runaway = JSON.stringify(options.prompt)
        .toLowerCase()
        .includes("runaway tool loop fixture");
      const response = runaway
        ? {
            type: "tool" as const,
            toolName: "query_telemetry" as const,
            input: {
              operation: "compare-releases" as const,
              baselineReleaseId: "baseline-concurrent",
              candidateReleaseId: "regression-sequential",
              windowMs: 60_000,
            },
          }
        : next(options.prompt);
      if (runaway) step += 1;
      if (response.type === "tool") {
        return {
          stream: simulateReadableStream({
            chunks: [
              {
                type: "tool-call",
                toolCallId: `deterministic-call-${step}`,
                toolName: response.toolName,
                input: JSON.stringify(response.input),
              },
              {
                type: "finish",
                finishReason: { unified: "tool-calls", raw: undefined },
                usage,
              },
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "text-1" },
            { type: "text-delta", id: "text-1", delta: response.text },
            { type: "text-end", id: "text-1" },
            {
              type: "finish",
              finishReason: { unified: "stop", raw: undefined },
              usage,
            },
          ],
        }),
      };
    },
  });
}

export function createAgentModel(environment: ModelEnvironment): LanguageModel {
  return selectAgentModel(environment, {
    fake: createDeterministicModel,
    workersAI: (binding, modelId) => createWorkersAI({ binding })(modelId),
  });
}
