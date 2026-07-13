import { Think } from "@cloudflare/think";
import type { TurnConfig, TurnContext } from "@cloudflare/think";
import type { LanguageModel, ToolSet } from "ai";
import { routeAgentRequest } from "agents";

import { createAgentModel } from "./agent/model";
import { createAgentEvidenceServices } from "./agent/evidence-services";
import { findRepresentativeTraceId } from "./agent/evidence-identifiers";
import { createRemediationAction } from "./agent/remediation-action";
import { createAgentRemediationService } from "./agent/remediation-services";
import { remediationFixture } from "../../../packages/test-fixtures/src/remediation";
import { createInvestigationTools } from "./agent/tools";
import { handlePlatformRequest, type PlatformBindings } from "./routing";
import { createTelemetryStore } from "./telemetry/store";

export interface PlatformEnvironment extends PlatformBindings {
  REGRESSION_SURGEON_AGENT: DurableObjectNamespace<RegressionSurgeonAgent>;
}

export class RegressionSurgeonAgent extends Think<PlatformEnvironment> {
  override maxSteps = 16;
  override workspaceBash = false;

  override getModel(): LanguageModel {
    return createAgentModel(this.env);
  }

  override getSystemPrompt(): string {
    const measuredEvidence =
      this.env.EVIDENCE_BASELINE_RELEASE_ID &&
      this.env.EVIDENCE_DEGRADED_RELEASE_ID &&
      this.env.EVIDENCE_DEGRADED_SINCE_MS &&
      this.env.EVIDENCE_DEGRADED_UNTIL_MS
        ? `The measured baseline release is ${this.env.EVIDENCE_BASELINE_RELEASE_ID} and the measured degraded release is ${this.env.EVIDENCE_DEGRADED_RELEASE_ID}. Compare them with windowMs 2592000000. Search degraded traces with sinceMs ${this.env.EVIDENCE_DEGRADED_SINCE_MS}, untilMs ${this.env.EVIDENCE_DEGRADED_UNTIL_MS}, releaseId ${this.env.EVIDENCE_DEGRADED_RELEASE_ID}, and limit 5. Use those exact values.`
        : "Ask the user for the measured baseline and degraded release IDs before querying telemetry.";
    return `You are Regression Surgeon, an evidence-first latency investigator.
${measuredEvidence}
Use only the active bounded tools. First compare measured releases, then inspect slow traces
and one representative trace, then resolve the degraded release to an immutable commit and pull
request, and finally read only the relevant allowlisted source at that commit. Do not propose a cause
or fix before trace, release, commit, and pull-request evidence are present.
Do not repeat a successful tool operation. If a bounded tool returns an error, retry it at most once,
then report the missing evidence with low confidence instead of looping.

Only after that evidence is present may you propose one surgical source change through
create_draft_pr. That action always requires explicit human approval. Never represent a preview as a
GitHub write, and never claim a branch, commit, or draft PR exists unless the action result says so.

Your final report must contain four explicit sections: Evidence (identifiers and measurements),
Inference (reasoning derived from that evidence), Confidence (high, medium, or low with rationale),
and Unknowns (remaining uncertainty). Clearly distinguish observed facts from inference. Never claim
that a write occurred unless the action result proves it. Never claim a merge, deployment, or
rollback occurred.`;
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

  override getActions() {
    const writeEnabled =
      this.env.MODEL_MODE === "workers-ai" && this.env.GITHUB_WRITE_ENABLED === "true";
    return { create_draft_pr: this.createRemediationAction(writeEnabled) };
  }

  createRemediationAction(writeEnabled: boolean, mode = this.env.MODEL_MODE) {
    const service = createAgentRemediationService({
      mode,
      repository: { owner: this.env.GITHUB_OWNER, repo: this.env.GITHUB_REPO },
      writeEnabled,
      ...(this.env.GITHUB_TOKEN === undefined ? {} : { token: this.env.GITHUB_TOKEN }),
    });
    return createRemediationAction(service, {
      idempotencyScope: writeEnabled ? "write" : "preview",
    });
  }

  override beforeTurn(_context: TurnContext): TurnConfig {
    return {
      activeTools: ["query_telemetry", "inspect_release", "read_repo_files", "create_draft_pr"],
    };
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

  async runLocalRemediationPreview() {
    await this.onStart();
    const messages = await this.getMessages();
    const report = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const traceId =
      findRepresentativeTraceId(messages) ??
      /Representative trace: ([A-Za-z0-9_-]+)/.exec(report)?.[1];
    if (traceId === undefined) throw new Error("Investigation trace evidence is unavailable.");
    const action = this.createRemediationAction(false, "fake");
    return action.config.execute(
      {
        ...remediationFixture,
        incident: { ...remediationFixture.incident, traceId },
      },
      {} as never,
    );
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
