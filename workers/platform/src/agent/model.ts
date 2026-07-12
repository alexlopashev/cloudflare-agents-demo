import type { LanguageModel } from "ai";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { createWorkersAI } from "workers-ai-provider";

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
  return new MockLanguageModelV3({
    modelId: "regression-surgeon-deterministic",
    doGenerate: async () => ({
      content: [{ type: "text", text: "Deterministic local response." }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 3, text: 3, reasoning: undefined },
      },
      warnings: [],
    }),
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "text-1" },
          { type: "text-delta", id: "text-1", delta: "Deterministic local response." },
          { type: "text-end", id: "text-1" },
          {
            type: "finish",
            finishReason: { unified: "stop", raw: undefined },
            logprobs: undefined,
            usage: {
              inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
              outputTokens: { total: 3, text: 3, reasoning: undefined },
            },
          },
        ],
      }),
    }),
  });
}

export function createAgentModel(environment: ModelEnvironment): LanguageModel {
  return selectAgentModel(environment, {
    fake: createDeterministicModel,
    workersAI: (binding, modelId) => createWorkersAI({ binding })(modelId),
  });
}
