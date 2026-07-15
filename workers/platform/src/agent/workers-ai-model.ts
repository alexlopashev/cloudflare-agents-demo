import type { LanguageModel } from "ai";
import { createWorkersAI } from "workers-ai-provider";

import { parseAiGatewayId } from "../../../../packages/contracts/src/ai-gateway";

export const WORKERS_AI_MODEL = "@cf/zai-org/glm-5.2";
export const WORKERS_AI_MODEL_SETTINGS = {
  parallel_tool_calls: false,
} as const;

export function createWorkersAiModel(
  binding: Ai,
  gatewayId: string,
  modelId = WORKERS_AI_MODEL,
  settings = WORKERS_AI_MODEL_SETTINGS,
): LanguageModel {
  return createWorkersAI({ binding, gateway: { id: parseAiGatewayId(gatewayId) } })(
    modelId,
    settings,
  );
}
