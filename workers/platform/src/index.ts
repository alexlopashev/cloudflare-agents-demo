import { Think } from "@cloudflare/think";
import type { LanguageModel } from "ai";
import { routeAgentRequest } from "agents";

import { createAgentModel } from "./agent/model";
import { handlePlatformRequest, type PlatformBindings } from "./routing";

export interface PlatformEnvironment extends PlatformBindings {
  REGRESSION_SURGEON_AGENT: DurableObjectNamespace<RegressionSurgeonAgent>;
  TELEMETRY_DB: D1Database;
}

export class RegressionSurgeonAgent extends Think<PlatformEnvironment> {
  override maxSteps = 8;

  override getModel(): LanguageModel {
    return createAgentModel(this.env);
  }

  override getSystemPrompt(): string {
    return "You are Regression Surgeon. Gather measured evidence before drawing conclusions.";
  }
}

const platformWorker = {
  async fetch(request: Request, environment: PlatformEnvironment): Promise<Response> {
    return handlePlatformRequest(request, environment, async (agentRequest, bindings) =>
      routeAgentRequest(agentRequest, bindings),
    );
  },
} satisfies ExportedHandler<PlatformEnvironment>;

export default platformWorker;
