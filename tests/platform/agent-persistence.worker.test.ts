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
  it("persists the configured incident while replacing per-investigation state", async () => {
    const stub = env.REGRESSION_SURGEON_AGENT.getByName("incident-state-contract");
    const states = await runInDurableObject<
      RegressionSurgeonAgent,
      { first: RegressionSurgeonAgent["state"]; second: RegressionSurgeonAgent["state"] }
    >(stub, async (instance) => {
      const first = instance.startConfiguredInvestigation();
      const second = instance.startConfiguredInvestigation();
      return { first, second };
    });

    expect(states.first).toMatchObject({
      status: "investigating",
      receipt: {
        investigationId:
          states.first.status === "investigating" ? states.first.investigationId : "",
        processedToolCallIds: [],
        phases: [
          { toolName: "compare_releases", status: "pending", attempts: [] },
          { toolName: "find_slow_traces", status: "pending", attempts: [] },
          { toolName: "inspect_trace", status: "pending", attempts: [] },
          { toolName: "inspect_release", status: "pending", attempts: [] },
          { toolName: "read_repo_files", status: "pending", attempts: [] },
        ],
      },
      incident: {
        incidentId: "configured-latency-regression",
        baselineReleaseId: "baseline-concurrent",
        degradedReleaseId: "regression-sequential",
      },
    });
    if (states.first.status !== "investigating" || states.second.status !== "investigating") {
      throw new Error("Expected incident-scoped investigation state.");
    }
    expect(states.second).toMatchObject({ incident: states.first.incident });
    expect(states.second.investigationId).not.toBe(states.first.investigationId);
    if (states.second.status !== "investigating") throw new Error("Expected active investigation");
    expect(states.second.receipt.investigationId).toBe(states.second.investigationId);
    expect(states.second.receipt).not.toEqual(states.first.receipt);

    await evictDurableObject(stub);
    const restored = await runInDurableObject<
      RegressionSurgeonAgent,
      RegressionSurgeonAgent["state"]
    >(stub, async (instance) => instance.state);
    expect(restored).toEqual(states.second);
  });

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

  it("bounds a complete evidence chain without truncating the final report", async () => {
    const id = env.REGRESSION_SURGEON_AGENT.idFromName("step-budget-contract");
    const stub = env.REGRESSION_SURGEON_AGENT.get(id);

    const maxSteps = await runInDurableObject<RegressionSurgeonAgent, number>(
      stub,
      async (instance) => instance.maxSteps,
    );

    expect(maxSteps).toBe(16);
  });
});
