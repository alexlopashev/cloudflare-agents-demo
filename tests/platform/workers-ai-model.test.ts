import { describe, expect, it, vi } from "vitest";

const { createWorkersAI, languageModel, selectModel } = vi.hoisted(() => {
  const model = { modelId: "live-workers-ai" };
  const select = vi.fn(() => model);
  return { createWorkersAI: vi.fn(() => select), languageModel: model, selectModel: select };
});

vi.mock("workers-ai-provider", () => ({ createWorkersAI }));

import {
  createWorkersAiModel,
  WORKERS_AI_MODEL,
  WORKERS_AI_MODEL_SETTINGS,
} from "../../workers/platform/src/agent/workers-ai-model";

describe("Workers AI model construction", () => {
  it("pins GLM-5.2 and routes the binding through the named Gateway", () => {
    const binding = { run: vi.fn() } as unknown as Ai;

    expect(createWorkersAiModel(binding, "regression-surgeon")).toBe(languageModel);
    expect(createWorkersAI).toHaveBeenCalledWith({
      binding,
      gateway: { id: "regression-surgeon" },
    });
    expect(selectModel).toHaveBeenCalledWith(WORKERS_AI_MODEL, WORKERS_AI_MODEL_SETTINGS);
    expect(WORKERS_AI_MODEL).toBe("@cf/zai-org/glm-5.2");
  });
});
