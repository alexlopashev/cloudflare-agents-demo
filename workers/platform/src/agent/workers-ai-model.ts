import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

export const WORKERS_AI_MODEL = "@cf/zai-org/glm-4.7-flash";
export const WORKERS_AI_MODEL_SETTINGS = {
  parallel_tool_calls: false,
} as const;

export function createWorkersAiModel(
  binding: Ai,
  modelId = WORKERS_AI_MODEL,
  settings = WORKERS_AI_MODEL_SETTINGS,
): LanguageModel {
  return createWorkersAI({ binding })(modelId, settings);
}
