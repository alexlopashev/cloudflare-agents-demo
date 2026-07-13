import type { PrepareStepContext, TurnConfig, TurnContext } from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import type { LanguageModel, ToolSet } from "ai";
import {
  configuredIncidentReference,
  parseIncidentReference,
  type IncidentReference,
} from "../../../packages/contracts/src/incident";
import { remediationFixture } from "../../../packages/test-fixtures/src/remediation";
import { findRepresentativeTraceId } from "./agent/evidence-identifiers";
import { createAgentEvidenceServices } from "./agent/evidence-services";
import {
  evidenceInvestigationRequested,
  evidenceStepsFromModelMessages,
  messagesForCurrentInvestigation,
  nextRequiredEvidenceTool,
} from "./agent/evidence-step-policy";
import { createAgentModel } from "./agent/model";
import { createRemediationAction } from "./agent/remediation-action";
import { createAgentRemediationService } from "./agent/remediation-services";
import { createInvestigationTools } from "./agent/tools";
import { handlePlatformRequest, type PlatformBindings } from "./routing";
import { createTelemetryStore } from "./telemetry/store";

export interface PlatformEnvironment extends PlatformBindings {
  REGRESSION_SURGEON_AGENT: DurableObjectNamespace<RegressionSurgeonAgent>;
}

type EvidenceStepConfig = {
  activeTools: ("query_telemetry" | "inspect_release" | "read_repo_files")[];
  toolChoice: {
    type: "tool";
    toolName: "query_telemetry" | "inspect_release" | "read_repo_files";
  };
  system: string;
};

export type InvestigationAgentState =
  | { status: "idle" }
  | {
      status: "investigating";
      investigationId: string;
      incident: IncidentReference;
      startedAtMs: number;
    };

export class RegressionSurgeonAgent extends Think<PlatformEnvironment, InvestigationAgentState> {
  override initialState: InvestigationAgentState = { status: "idle" };
  override maxSteps = 16;
  override workspaceBash = false;

  override getModel(): LanguageModel {
    return createAgentModel(this.env);
  }

  override getSystemPrompt(): string {
    const incident = configuredIncidentReference(this.env);
    const measuredEvidence = `The configured incident is ${incident.incidentId}. Its measured baseline release is ${incident.baselineReleaseId} and its measured degraded release is ${incident.degradedReleaseId}. Compare them with windowMs 2592000000. Search degraded traces with sinceMs ${incident.traceWindow.sinceMs}, untilMs ${incident.traceWindow.untilMs}, releaseId ${incident.degradedReleaseId}, and limit 5. Use those exact values.`;
    return `You are Regression Surgeon, an evidence-first latency investigator.
${measuredEvidence}
Use only the active bounded tools. First compare measured releases, then inspect slow traces
and one representative trace, then resolve the degraded release to an immutable commit and pull
request, and finally read only the relevant allowlisted source at that commit. Do not propose a cause
or fix before trace, release, commit, and pull-request evidence are present.
Before producing final text, you must complete every evidence operation: compare releases; find slow
traces; inspect one representative trace; inspect the degraded release; and read the relevant
allowlisted source at that commit.
Do not repeat a successful tool operation. If a bounded tool returns an error, retry it at most once,
then report the missing evidence with low confidence instead of looping.

Only after that evidence is present may you propose one surgical source change through
create_draft_pr. That action always requires explicit human approval. Never represent a preview as a
GitHub write, and never claim a branch, commit, or draft PR exists unless the action result says so.

Your final report must contain four explicit sections: Evidence (the incident ID, release and trace
window identifiers, and measurements),
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
      { incident: configuredIncidentReference(this.env) },
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

  startConfiguredInvestigation(): Extract<InvestigationAgentState, { status: "investigating" }> {
    const state = {
      status: "investigating" as const,
      investigationId: crypto.randomUUID(),
      incident: configuredIncidentReference(this.env),
      startedAtMs: Date.now(),
    };
    this.setState(state);
    return state;
  }

  private activeIncident(): IncidentReference {
    if (this.state.status !== "investigating") {
      throw new Error("An active incident-scoped investigation is required.");
    }
    const persisted = parseIncidentReference(this.state.incident);
    const configured = configuredIncidentReference(this.env);
    if (JSON.stringify(persisted) !== JSON.stringify(configured)) {
      throw new Error("Persisted investigation incident does not match runtime configuration.");
    }
    return persisted;
  }

  override beforeTurn(context: TurnContext): TurnConfig {
    const messages = Array.isArray(context.messages) ? context.messages : [];
    if (!context.continuation && evidenceInvestigationRequested(messages)) {
      this.startConfiguredInvestigation();
    }
    return {
      activeTools: ["query_telemetry", "inspect_release", "read_repo_files", "create_draft_pr"],
    };
  }

  override beforeStep(context: PrepareStepContext): EvidenceStepConfig | undefined {
    const currentMessages = messagesForCurrentInvestigation(context.messages);
    const evidenceSteps = [...evidenceStepsFromModelMessages(currentMessages), ...context.steps];
    const hasEvidence = evidenceSteps.some((step) => step.toolResults.length > 0);
    const requiredTool =
      nextRequiredEvidenceTool(evidenceSteps) ??
      (!hasEvidence && evidenceInvestigationRequested(currentMessages)
        ? "query_telemetry"
        : undefined);
    if (requiredTool === undefined) return;
    return {
      activeTools: [requiredTool],
      toolChoice: { type: "tool", toolName: requiredTool },
      system: `${this.getSystemPrompt()}\n\nComplete the missing evidence operation through ${requiredTool} now. Do not produce final text in this step.`,
    };
  }

  async runLocalInvestigation() {
    await this.onStart();
    await this.clearMessages();
    this.startConfiguredInvestigation();
    await this.runTurn({
      input:
        "Investigate the measured latency regression. Before the final report, compare releases, find slow traces, inspect one representative trace, inspect the degraded release, and read the relevant allowlisted source at that commit.",
    });
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
    return { incident: this.activeIncident(), toolTypes, report };
  }

  async runLocalRemediationPreview() {
    await this.onStart();
    const messages = await this.getMessages();
    const currentMessages = messagesForCurrentInvestigation(messages);
    const report = messages
      .filter((message) => message.role === "assistant")
      .flatMap((message) => message.parts)
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n");
    const traceId =
      findRepresentativeTraceId(currentMessages) ??
      /Representative trace: ([A-Za-z0-9_-]+)/.exec(report)?.[1];
    if (traceId === undefined) throw new Error("Investigation trace evidence is unavailable.");
    const incident = this.activeIncident();
    const action = this.createRemediationAction(false, "fake");
    return action.config.execute(
      {
        ...remediationFixture,
        incident: { ...remediationFixture.incident, ...incident, traceId },
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
