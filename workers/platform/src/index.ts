import type { PrepareStepContext, TurnConfig, TurnContext } from "@cloudflare/think";
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { hasToolCall, type LanguageModel, type ToolSet } from "ai";
import {
  configuredIncidentReference,
  parseIncidentReference,
  type IncidentReference,
} from "../../../packages/contracts/src/incident";
import { agentComposition } from "./agent/active-composition";
import {
  createEvidenceReceipt,
  evidenceReceiptComplete,
  evidenceResultsFromModelMessages,
  evidenceToolNames,
  nextEvidenceTool,
  recordEvidenceResult,
  type EvidenceReceipt,
  type EvidenceToolName,
  type EvidenceToolResult,
} from "./agent/evidence-receipt";
import { configuredComparisonWindowMs, configuredSlowTraceLimit } from "./agent/evidence-policy";
import {
  evidenceInvestigationRequested,
  messagesForCurrentInvestigation,
  remediationPreviewRequested,
} from "./agent/evidence-step-policy";
import { createRemediationAction } from "./agent/remediation-action";
import { createInvestigationTools } from "./agent/tools";
import { composeAgentConfiguration, type AgentConfiguration } from "./config";
import { createHealthRemediationProposal } from "./remediation/health-proposal";
import {
  remediationChangeCounts,
  remediationProposalFingerprint,
  type RemediationProposal,
} from "./remediation/service";
import { handlePlatformRequest, type PlatformBindings } from "./routing";
import { createTelemetryStore } from "./telemetry/store";
import { assertConfiguredEvidenceReady } from "./verification/evidence-readiness";

export interface PlatformEnvironment extends PlatformBindings {
  REGRESSION_SURGEON_AGENT: DurableObjectNamespace<RegressionSurgeonAgent>;
}

type AgentToolName = EvidenceToolName | "create_draft_pr";

type EvidenceStepConfig = {
  activeTools?: AgentToolName[];
  toolChoice?: {
    type: "tool";
    toolName: AgentToolName;
  };
  system: string;
};

export type PreparedRemediation = {
  fingerprint: string;
  writeEnabled: boolean;
  proposal: RemediationProposal;
  diff: {
    additions: number;
    currentContent: string;
    deletions: number;
    path: string;
    expectedBlobSha: string;
    replacementContent: string;
  };
};

export type InvestigationAgentState =
  | { status: "idle" }
  | {
      status: "investigating";
      investigationId: string;
      incident: IncidentReference;
      preparedRemediation?: PreparedRemediation;
      receipt: EvidenceReceipt;
      startedAtMs: number;
    };

export class RegressionSurgeonAgent extends Think<PlatformEnvironment, InvestigationAgentState> {
  #agentConfiguration: AgentConfiguration | undefined;

  override initialState: InvestigationAgentState = { status: "idle" };
  override maxSteps = 16;
  override workspaceBash = false;

  private agentConfiguration(): AgentConfiguration {
    this.#agentConfiguration ??= composeAgentConfiguration({
      aiGatewayId: this.env.AI_GATEWAY_ID,
      githubOwner: this.env.GITHUB_OWNER,
      githubRepo: this.env.GITHUB_REPO,
      ...(this.env.GITHUB_TOKEN === undefined ? {} : { githubToken: this.env.GITHUB_TOKEN }),
      githubWriteEnabled: this.env.GITHUB_WRITE_ENABLED,
      modelMode: this.env.MODEL_MODE,
    });
    return this.#agentConfiguration;
  }

  override getModel(): LanguageModel {
    return agentComposition.createModel(this.env, this.agentConfiguration());
  }

  override getSystemPrompt(): string {
    const incident = configuredIncidentReference(this.env);
    const measuredEvidence = `The configured incident is ${incident.incidentId}. Its measured baseline release is ${incident.baselineReleaseId} and its measured degraded release is ${incident.degradedReleaseId}. The server binds comparison windowMs ${configuredComparisonWindowMs} and slow-trace selectors sinceMs ${incident.traceWindow.sinceMs}, untilMs ${incident.traceWindow.untilMs}, releaseId ${incident.degradedReleaseId}, and limit ${configuredSlowTraceLimit}; you cannot select or modify them.`;
    const receiptContext =
      this.state.status === "investigating"
        ? ` The active evidence receipt is ${this.state.receipt.investigationId}; cite that receipt identifier in the Evidence section.`
        : "";
    const prepared =
      this.state.status === "investigating" && this.state.preparedRemediation !== undefined
        ? `\nThe complete receipt prepared remediation fingerprint ${this.state.preparedRemediation.fingerprint}. You may call create_draft_pr only with this unchanged JSON: ${JSON.stringify({ proposalFingerprint: this.state.preparedRemediation.fingerprint })}`
        : "";
    return `You are Regression Surgeon, an evidence-first latency investigator.
${measuredEvidence}${receiptContext}
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
and Unknowns (remaining uncertainty). Format each section name as a level-two Markdown heading—two
hash characters, one space, then the section name—on its own line in that exact order. Clearly
distinguish observed facts from inference. Never claim that a write occurred unless the action result
proves it. Never claim a merge, deployment, or rollback occurred.${prepared}`;
  }

  override getTools(): ToolSet {
    const configuration = this.agentConfiguration();
    const store = createTelemetryStore(this.env.TELEMETRY_DB);
    const incident = configuredIncidentReference(this.env);
    return createInvestigationTools(
      agentComposition.createEvidenceServices({
        repository: {
          owner: configuration.github.owner,
          repo: configuration.github.repo,
        },
        store,
        sourceReleaseId: incident.degradedReleaseId,
        ...(configuration.github.token === undefined ? {} : { token: configuration.github.token }),
      }),
      {
        incident,
        selectedSource: () => {
          if (this.state.status !== "investigating") return;
          const { commitSha, sourcePath } = this.state.receipt.evidence;
          return commitSha === undefined || sourcePath === undefined
            ? undefined
            : { commitSha, path: sourcePath };
        },
        selectedTraceId: () =>
          this.state.status === "investigating"
            ? this.state.receipt.evidence.selectedTraceId
            : undefined,
      },
    );
  }

  override getActions() {
    const writeEnabled = agentComposition.writeEnabled(this.agentConfiguration());
    return { create_draft_pr: this.createRemediationAction(writeEnabled) };
  }

  createRemediationAction(writeEnabled: boolean) {
    const configuration = this.agentConfiguration();
    const incident = configuredIncidentReference(this.env);
    const service = agentComposition.createRemediationService({
      repository: {
        owner: configuration.github.owner,
        repo: configuration.github.repo,
      },
      writeEnabled,
      sourceReleaseId: incident.degradedReleaseId,
      previewBaseSha: this.env.GIT_SHA,
      store: createTelemetryStore(this.env.TELEMETRY_DB),
      ...(configuration.github.token === undefined ? {} : { token: configuration.github.token }),
    });
    return createRemediationAction(service, {
      idempotencyScope: writeEnabled ? "write" : "preview",
      resolveProposal: (proposalFingerprint) => {
        if (this.state.status !== "investigating") return;
        const prepared = this.state.preparedRemediation;
        return prepared?.fingerprint === proposalFingerprint ? prepared.proposal : undefined;
      },
    });
  }

  private async prepareRemediation(
    receipt: EvidenceReceipt,
  ): Promise<PreparedRemediation | undefined> {
    if (!evidenceReceiptComplete(receipt)) return;
    const evidence = receipt.evidence;
    if (
      evidence.inspectedTraceId === undefined ||
      evidence.commitSha === undefined ||
      evidence.pullRequest?.status !== "found" ||
      evidence.sourcePath === undefined ||
      evidence.blobSha === undefined ||
      evidence.sourceContent === undefined
    ) {
      return;
    }
    const proposal = createHealthRemediationProposal({
      currentContent: evidence.sourceContent,
      incident: {
        ...receipt.incident,
        traceId: evidence.inspectedTraceId,
        regressionCommitSha: evidence.commitSha,
        sourcePullRequestNumber: evidence.pullRequest.number,
      },
      expectedBaseSha: evidence.commitSha,
      expectedBlobSha: evidence.blobSha,
      path: evidence.sourcePath,
    });
    const changes = remediationChangeCounts(evidence.sourceContent, proposal.replacementContent);
    return {
      fingerprint: `proposal-v1-${await remediationProposalFingerprint(proposal)}`,
      writeEnabled: agentComposition.writeEnabled(this.agentConfiguration()),
      proposal,
      diff: {
        additions: changes.additions,
        currentContent: evidence.sourceContent,
        deletions: changes.deletions,
        path: proposal.path,
        expectedBlobSha: proposal.expectedBlobSha,
        replacementContent: proposal.replacementContent,
      },
    };
  }

  startConfiguredInvestigation(): Extract<InvestigationAgentState, { status: "investigating" }> {
    const investigationId = crypto.randomUUID();
    const incident = configuredIncidentReference(this.env);
    const state = {
      status: "investigating" as const,
      investigationId,
      incident,
      receipt: createEvidenceReceipt(investigationId, incident),
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
    if (
      JSON.stringify(persisted) !== JSON.stringify(configured) ||
      JSON.stringify(this.state.receipt.incident) !== JSON.stringify(configured) ||
      this.state.receipt.investigationId !== this.state.investigationId
    ) {
      throw new Error("Persisted investigation incident does not match runtime configuration.");
    }
    return persisted;
  }

  override beforeTurn(context: TurnContext): TurnConfig {
    const messages = Array.isArray(context.messages) ? context.messages : [];
    if (!context.continuation && evidenceInvestigationRequested(messages)) {
      this.startConfiguredInvestigation();
    }
    const remediationEligible =
      this.state.status === "investigating" && this.state.preparedRemediation !== undefined;
    return {
      activeTools: [...evidenceToolNames, ...(remediationEligible ? ["create_draft_pr"] : [])],
      stopWhen: hasToolCall("create_draft_pr"),
    };
  }

  override async beforeStep(context: PrepareStepContext): Promise<EvidenceStepConfig | undefined> {
    if (this.state.status !== "investigating") {
      if (!evidenceInvestigationRequested(context.messages)) return;
      this.startConfiguredInvestigation();
    }
    if (this.state.status !== "investigating") return;
    const currentMessages = messagesForCurrentInvestigation(context.messages);
    const currentStepResults: EvidenceToolResult[] = context.steps.flatMap((step) =>
      step.toolResults.map((result) => ({
        toolCallId: result.toolCallId,
        toolName: result.toolName,
        input: result.input,
        output: result.output,
      })),
    );
    const results = [...evidenceResultsFromModelMessages(currentMessages), ...currentStepResults];
    const activeState = this.state;
    const receipt = results.reduce(
      (current, result) => recordEvidenceResult(current, result),
      activeState.receipt,
    );
    const preparedRemediation =
      activeState.preparedRemediation ?? (await this.prepareRemediation(receipt));
    if (
      receipt !== activeState.receipt ||
      preparedRemediation !== activeState.preparedRemediation
    ) {
      this.setState({
        ...activeState,
        receipt,
        ...(preparedRemediation === undefined ? {} : { preparedRemediation }),
      });
    }
    const requiredTool = nextEvidenceTool(receipt);
    if (requiredTool === undefined) {
      if (!evidenceReceiptComplete(receipt)) {
        return {
          activeTools: [],
          system: `${this.getSystemPrompt()}\n\nThe current evidence phase's bounded retry is exhausted. Call no tool, report the missing evidence with low confidence, and do not propose remediation.`,
        };
      }
      if (preparedRemediation !== undefined && remediationPreviewRequested(currentMessages)) {
        return {
          activeTools: ["create_draft_pr"],
          toolChoice: { type: "tool", toolName: "create_draft_pr" },
          system: `Submit the exact prepared remediation through create_draft_pr now. Do not replace or omit its receipt-bound input.\n\n${this.getSystemPrompt()}`,
        };
      }
      return {
        activeTools: [],
        system: `${this.getSystemPrompt()}\n\nThe evidence receipt is complete. Produce the required final report now without calling another tool.`,
      };
    }
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
    if (this.state.status !== "investigating") {
      throw new Error("Investigation state was lost before its report completed.");
    }
    return {
      incident: this.activeIncident(),
      preparedRemediation: this.state.preparedRemediation,
      receipt: this.state.receipt,
      toolTypes,
      report,
    };
  }

  async runLocalEvidenceReadiness(): Promise<void> {
    await assertConfiguredEvidenceReady(
      createTelemetryStore(this.env.TELEMETRY_DB),
      configuredIncidentReference(this.env),
      this.env.GIT_SHA,
    );
  }

  async runLocalRemediationPreview() {
    await this.onStart();
    if (this.state.status !== "investigating" || this.state.preparedRemediation === undefined) {
      throw new Error("A complete incident-scoped evidence receipt is required for remediation.");
    }
    this.activeIncident();
    const prepared = this.state.preparedRemediation;
    const action = this.createRemediationAction(false);
    return action.config.execute(
      {
        proposalFingerprint: prepared.fingerprint,
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
