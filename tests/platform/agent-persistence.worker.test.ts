import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";

import type { PlatformEnvironment, RegressionSurgeonAgent } from "../../workers/platform/src/index";

declare global {
  namespace Cloudflare {
    interface Env extends PlatformEnvironment {}
  }
}

describe("RegressionSurgeonAgent persistence", () => {
  it("persists one copy of an idempotent message across Durable Object eviction", async () => {
    const id = env.REGRESSION_SURGEON_AGENT.idFromName("persistence-contract");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);
    const message = {
      id: "message-1",
      role: "user" as const,
      parts: [{ type: "text" as const, text: "Investigate the regression." }],
    };

    const beforeEviction = await runInDurableObject<RegressionSurgeonAgent, (typeof message)[]>(
      stub,
      async (instance) => {
        await instance.onStart();
        await instance.addMessages([message]);
        await instance.addMessages([message]);
        return instance.messages as (typeof message)[];
      },
    );
    expect(beforeEviction).toEqual([message]);

    await evictDurableObject(stub);

    const afterEviction = await runInDurableObject<RegressionSurgeonAgent, (typeof message)[]>(
      stub,
      async (instance) => {
        await instance.onStart();
        return instance.messages as (typeof message)[];
      },
    );
    expect(afterEviction).toEqual([message]);
  });

  it("selects the deterministic model inside workerd without an AI binding", async () => {
    const id = env.REGRESSION_SURGEON_AGENT.idFromName("model-contract");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);

    const modelId = await runInDurableObject<RegressionSurgeonAgent, string>(
      stub,
      async (instance) => {
        await instance.onStart();
        const model = instance.getModel();
        return typeof model === "string" ? model : model.modelId;
      },
    );

    expect(modelId).toBe("regression-surgeon-deterministic");
  });
});
