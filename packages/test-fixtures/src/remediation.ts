import { regressionSource } from "./scenario";

export const regressionHealthSource = `const services: ServiceHealthResult[] = [];
if (options.loadingMode === "sequential") {
  for (const service of serviceDefinitions) {
    services.push(await loadService(service));
  }
} else {
  services.push(...(await Promise.all(serviceDefinitions.map(loadService))));
}`;

export const boundedConcurrencyHealthSource = `const services: ServiceHealthResult[] = [];
const maximumConcurrentChecks = 2;
for (let index = 0; index < serviceDefinitions.length; index += maximumConcurrentChecks) {
  const batch = serviceDefinitions.slice(index, index + maximumConcurrentChecks);
  services.push(...(await Promise.all(batch.map(loadService))));
}`;

export const remediationFixture = {
  incident: {
    incidentId: "configured-latency-regression",
    baselineReleaseId: "baseline-concurrent",
    degradedReleaseId: "regression-sequential",
    traceWindow: { sinceMs: 1_700_086_400_000, untilMs: 1_700_086_460_000 },
    traceId: "scenario-trace-34",
    regressionCommitSha: regressionSource.commitSha,
    sourcePullRequestNumber: regressionSource.pullRequestNumber,
  },
  expectedBaseSha: regressionSource.commitSha,
  expectedBlobSha: "3333333333333333333333333333333333333333",
  path: "workers/platform/src/api/health.ts",
  replacementContent: boundedConcurrencyHealthSource,
  title: "fix: bound health-check concurrency",
  rationale:
    "Preserve the downstream-pressure intent while removing the fully serialized critical path.",
  risk: "A bound of two permits limited overlap and must remain within downstream capacity.",
  validationSteps: ["Run mise run check", "Run mise run e2e"],
};
