import { Think } from "@cloudflare/think";
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import type { LanguageModel, ToolSet } from "ai";
import { routeAgentRequest } from "agents";

import { createAgentModel } from "./agent/model";
import { createAgentEvidenceServices } from "./agent/evidence-services";
import { createInvestigationTools } from "./agent/tools";
import { handlePlatformRequest, type PlatformBindings } from "./routing";
import { createTelemetryStore } from "./telemetry/store";

export interface PlatformEnvironment extends PlatformBindings {
  REGRESSION_SURGEON_AGENT: DurableObjectNamespace<RegressionSurgeonAgent>;
}

export class RegressionSurgeonAgent extends Think<PlatformEnvironment> {
  override maxSteps = 8;
  override workspaceBash = false;

  override getModel(): LanguageModel {
    return createAgentModel(this.env);
  }

  override getSystemPrompt(): string {
    return `You are Regression Surgeon, an evidence-first latency investigator.
Use only the three active evidence tools. First compare measured releases, then inspect slow traces
and one representative trace, then resolve the degraded release to an immutable commit and pull
request, and finally read only the relevant allowlisted source at that commit. Do not propose a cause
or fix before trace, release, commit, and pull-request evidence are present.

Your final report must contain four explicit sections: Evidence (identifiers and measurements),
Inference (reasoning derived from that evidence), Confidence (high, medium, or low with rationale),
and Unknowns (remaining uncertainty). Clearly distinguish observed facts from inference. Never claim
that a write, deployment, rollback, or pull-request creation occurred.`;
  }

  override getTools(): ToolSet {
    const store = createTelemetryStore(this.env.TELEMETRY_DB);
    return createInvestigationTools(
      createAgentEvidenceServices({
        mode: this.env.MODEL_MODE,
        repository: { owner: this.env.GITHUB_OWNER, repo: this.env.GITHUB_REPO },
        store,
        ...(this.env.GITHUB_TOKEN === undefined ? {} : { token: this.env.GITHUB_TOKEN }),
      }),
    );
  }

  override beforeTurn(_context: TurnContext): TurnConfig {
    return { activeTools: ["query_telemetry", "inspect_release", "read_repo_files"] };
  }

  async runLocalInvestigation() {
    await this.onStart();
    await this.clearMessages();
    await this.runTurn({ input: "Investigate the measured latency regression." });
    const messages = await this.getMessages();
    const toolTypes = messages.flatMap((message) =>
      message.parts.map((part) => part.type).filter((type) => type.startsWith("tool-")),
    );
    const report = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    return { toolTypes, report };
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
