import type { AgentComposition } from "../agent/composition";
import { createDeterministicEvidenceServices } from "../agent/evidence-services";
import { createDeterministicModel } from "../agent/model";
import { createDeterministicRemediationService } from "../agent/remediation-services";

export const demoAgentComposition: AgentComposition = {
  createEvidenceServices: createDeterministicEvidenceServices,
  createModel(_environment, configuration) {
    if (configuration.modelMode !== "fake") {
      throw new TypeError("Demo composition requires deterministic model mode.");
    }
    return createDeterministicModel();
  },
  createRemediationService: createDeterministicRemediationService,
  writeEnabled() {
    return false;
  },
};
