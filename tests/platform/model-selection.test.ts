import { describe, expect, it, vi } from "vitest";

import { selectAgentModel } from "../../workers/platform/src/agent/model";
import { WORKERS_AI_MODEL_SETTINGS } from "../../workers/platform/src/agent/model";

describe("agent model selection", () => {
  it("uses the deterministic model without reading the Workers AI binding", () => {
    const fakeModel = { modelId: "deterministic" };
    const fake = vi.fn(() => fakeModel);
    const workersAI = vi.fn();
    const environment = {
      get AI(): never {
        throw new Error("fake mode must not access Workers AI");
      },
      get AI_GATEWAY_ID(): never {
        throw new Error("fake mode must not access AI Gateway");
      },
      MODEL_MODE: "fake" as const,
    };

    expect(selectAgentModel(environment, { fake, workersAI })).toBe(fakeModel);
    expect(fake).toHaveBeenCalledOnce();
    expect(workersAI).not.toHaveBeenCalled();
  });

  it("uses Workers AI with the pinned tool-capable model in live mode", () => {
    const liveModel = { modelId: "live" };
    const binding = { binding: "workers-ai" };
    const workersAI = vi.fn(() => liveModel);

    expect(
      selectAgentModel(
        { AI: binding, AI_GATEWAY_ID: "regression-surgeon", MODEL_MODE: "workers-ai" },
        { fake: vi.fn(), workersAI },
      ),
    ).toBe(liveModel);
    expect(workersAI).toHaveBeenCalledWith(
      binding,
      "@cf/zai-org/glm-5.2",
      WORKERS_AI_MODEL_SETTINGS,
      "regression-surgeon",
    );
  });

  it.each([
    undefined,
    "",
    "   ",
    "Invalid Gateway",
  ])("fails closed before live inference for an invalid AI Gateway ID (%s)", (gatewayId) => {
    expect(() =>
      selectAgentModel(
        {
          AI: {},
          ...(gatewayId === undefined ? {} : { AI_GATEWAY_ID: gatewayId }),
          MODEL_MODE: "workers-ai",
        },
        { fake: vi.fn(), workersAI: vi.fn() },
      ),
    ).toThrow(/gateway/i);
  });

  it("fails closed for an unsupported model mode", () => {
    expect(() =>
      selectAgentModel({ AI: {}, MODEL_MODE: "other" }, { fake: vi.fn(), workersAI: vi.fn() }),
    ).toThrow(/unsupported model mode/i);
  });
});
