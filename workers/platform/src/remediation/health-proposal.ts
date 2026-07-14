import type { RemediationProposal } from "./service";

const sequentialLoadingBlock = `      const services: ServiceHealthResult[] = [];
      if (options.loadingMode === "sequential") {
        for (const service of serviceDefinitions) services.push(await loadService(service));
      } else {
        services.push(...(await Promise.all(serviceDefinitions.map(loadService))));
      }`;

const boundedLoadingBlock = `      const services: ServiceHealthResult[] = [];
      const maximumConcurrentChecks = 2;
      for (let index = 0; index < serviceDefinitions.length; index += maximumConcurrentChecks) {
        const batch = serviceDefinitions.slice(index, index + maximumConcurrentChecks);
        services.push(...(await Promise.all(batch.map(loadService))));
      }`;

type HealthRemediationInput = Pick<
  RemediationProposal,
  "incident" | "expectedBaseSha" | "expectedBlobSha" | "path"
> & { currentContent: string };

export function createHealthRemediationProposal(
  input: HealthRemediationInput,
): RemediationProposal {
  const parts = input.currentContent.split(sequentialLoadingBlock);
  if (parts.length !== 2) {
    throw new TypeError("Evidenced health source does not contain one exact sequential block.");
  }
  return {
    incident: input.incident,
    expectedBaseSha: input.expectedBaseSha,
    expectedBlobSha: input.expectedBlobSha,
    path: input.path,
    replacementContent: `${parts[0]}${boundedLoadingBlock}${parts[1]}`,
    title: "fix: bound health-check concurrency",
    rationale:
      "Preserve the downstream-pressure intent while removing the fully serialized critical path.",
    risk: "A bound of two permits limited overlap and must remain within downstream capacity.",
    validationSteps: ["Run mise run check", "Run mise run e2e"],
  };
}
