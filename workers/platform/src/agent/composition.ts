import type { LanguageModel } from "ai";

import type { AgentConfiguration } from "../config";
import type { createRemediationService } from "../remediation/service";
import type { EvidenceServiceOptions } from "./evidence-services";
import type { RemediationServiceOptions } from "./remediation-services";
import type { InvestigationEvidenceServices } from "./tools";

export type AgentComposition = {
  createEvidenceServices(options: EvidenceServiceOptions): InvestigationEvidenceServices;
  createModel(environment: { AI?: Ai }, configuration: AgentConfiguration): LanguageModel;
  createRemediationService(
    options: RemediationServiceOptions,
  ): ReturnType<typeof createRemediationService>;
  writeEnabled(configuration: AgentConfiguration): boolean;
};
