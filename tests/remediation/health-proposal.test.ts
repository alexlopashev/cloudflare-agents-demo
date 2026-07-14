import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import {
  regressionHealthSource,
  remediationFixture,
} from "../../packages/test-fixtures/src/remediation";
import { createHealthRemediationProposal } from "../../workers/platform/src/remediation/health-proposal";
import { remediationChangeCounts } from "../../workers/platform/src/remediation/service";

const repositoryRoot = resolve(import.meta.dirname, "../..");

describe("health remediation proposal", () => {
  it("uses the same complete-file edit contract for deterministic and live evidence", () => {
    const evidencedSource = readFileSync(
      resolve(repositoryRoot, "workers/platform/src/api/health.ts"),
      "utf8",
    ).trimEnd();
    const proposal = createHealthRemediationProposal({
      currentContent: evidencedSource,
      incident: remediationFixture.incident,
      expectedBaseSha: remediationFixture.expectedBaseSha,
      expectedBlobSha: remediationFixture.expectedBlobSha,
      path: remediationFixture.path,
    });

    expect(regressionHealthSource).toBe(evidencedSource);
    expect(proposal.replacementContent).toBe(remediationFixture.replacementContent);
    expect(proposal.replacementContent.split("\n")).toHaveLength(
      evidencedSource.split("\n").length,
    );
    expect(proposal.replacementContent).toContain("const maximumConcurrentChecks = 2;");
    expect(proposal.replacementContent).not.toContain(
      "for (const service of serviceDefinitions) services.push(await loadService(service));",
    );
    expect(remediationChangeCounts(evidencedSource, proposal.replacementContent)).toEqual({
      additions: 4,
      deletions: 4,
    });
  });
});
