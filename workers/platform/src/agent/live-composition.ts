import type { AgentComposition } from "./composition";
import { createLiveEvidenceServices } from "./live-evidence-services";
import { createLiveRemediationService } from "./live-remediation-service";
import { createWorkersAiModel } from "./workers-ai-model";

export const liveAgentComposition: AgentComposition = {
  createEvidenceServices: createLiveEvidenceServices,
  createModel(environment, configuration) {
    if (
      configuration.modelMode !== "workers-ai" ||
      environment.AI === undefined ||
      configuration.aiGatewayId === undefined
    ) {
      throw new TypeError("Live composition requires Workers AI.");
    }
    return createWorkersAiModel(environment.AI, configuration.aiGatewayId);
  },
  createRemediationService: createLiveRemediationService,
  writeEnabled(configuration) {
    return configuration.github.writeEnabled;
  },
};
