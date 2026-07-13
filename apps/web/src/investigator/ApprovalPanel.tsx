export type ApprovalRequest = {
  additions: number;
  approvalId: string;
  changedLineCount: number;
  currentContent: string;
  deletions: number;
  expectedBlobSha: string;
  fileCount: 1;
  toolCallId: string;
  title: string;
  path: string;
  proposalFingerprint: string;
  rationale: string;
  regressionCommitSha: string;
  replacementContent: string;
  sourcePullRequestNumber: number;
  traceId: string;
  writePosture: "Preview only — external GitHub writes disabled" | "Live draft-PR writes enabled";
};

export type PreparedApprovalDetails = {
  fingerprint: string;
  writeEnabled: boolean;
  diff: {
    additions: number;
    currentContent: string;
    deletions: number;
    path: string;
    replacementContent: string;
  };
};

type ApprovalMessage = { id: string; parts: readonly unknown[] };

function property(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

function stringProperty(value: object, name: string): string | undefined {
  const candidate = property(value, name);
  return typeof candidate === "string" ? candidate : undefined;
}

function positiveIntegerProperty(value: object, name: string): number | undefined {
  const candidate = property(value, name);
  return Number.isSafeInteger(candidate) && Number(candidate) > 0 ? Number(candidate) : undefined;
}

export function buildApprovalRequests(
  messages: readonly ApprovalMessage[],
  prepared: PreparedApprovalDetails | undefined,
): ApprovalRequest[] {
  const requests: ApprovalRequest[] = [];
  for (const message of messages) {
    for (const part of message.parts) {
      if (part === null || typeof part !== "object") continue;
      if (
        stringProperty(part, "type") !== "tool-create_draft_pr" ||
        stringProperty(part, "state") !== "approval-requested"
      ) {
        continue;
      }
      const approval = property(part, "approval");
      const input = property(part, "input");
      if (
        approval === null ||
        typeof approval !== "object" ||
        input === null ||
        typeof input !== "object"
      ) {
        continue;
      }
      const incident = property(input, "incident");
      if (incident === null || typeof incident !== "object") continue;
      const approvalId = stringProperty(approval, "id");
      const toolCallId = stringProperty(part, "toolCallId");
      const title = stringProperty(input, "title");
      const path = stringProperty(input, "path");
      const proposalFingerprint = stringProperty(input, "proposalFingerprint");
      const replacementContent = stringProperty(input, "replacementContent");
      const rationale = stringProperty(input, "rationale");
      const expectedBlobSha = stringProperty(input, "expectedBlobSha");
      const traceId = stringProperty(incident, "traceId");
      const regressionCommitSha = stringProperty(incident, "regressionCommitSha");
      const sourcePullRequestNumber = positiveIntegerProperty(incident, "sourcePullRequestNumber");
      if (
        approvalId === undefined ||
        toolCallId === undefined ||
        title === undefined ||
        path === undefined ||
        proposalFingerprint === undefined ||
        replacementContent === undefined ||
        rationale === undefined ||
        expectedBlobSha === undefined ||
        traceId === undefined ||
        regressionCommitSha === undefined ||
        sourcePullRequestNumber === undefined ||
        prepared === undefined ||
        prepared.fingerprint !== proposalFingerprint ||
        prepared.diff.path !== path ||
        prepared.diff.replacementContent !== replacementContent
      ) {
        continue;
      }
      requests.push({
        additions: prepared.diff.additions,
        approvalId,
        changedLineCount: prepared.diff.additions + prepared.diff.deletions,
        currentContent: prepared.diff.currentContent,
        deletions: prepared.diff.deletions,
        expectedBlobSha,
        fileCount: 1,
        toolCallId,
        title,
        path,
        proposalFingerprint,
        rationale,
        regressionCommitSha,
        replacementContent,
        sourcePullRequestNumber,
        traceId,
        writePosture: prepared.writeEnabled
          ? "Live draft-PR writes enabled"
          : "Preview only — external GitHub writes disabled",
      });
    }
  }
  return requests;
}

export function ApprovalPanel({
  requests,
  onDecision,
}: {
  requests: readonly ApprovalRequest[];
  onDecision(approvalId: string, approved: boolean): void;
}) {
  if (requests.length === 0) return null;
  return (
    <section className="approval-panel" aria-label="Draft pull request approval">
      <p className="eyebrow">Human approval required</p>
      {requests.map((request) => (
        <article key={request.approvalId}>
          <h2>{request.title}</h2>
          <p className="write-posture">{request.writePosture}</p>
          <p>{request.rationale}</p>
          <dl>
            <div>
              <dt>Scope</dt>
              <dd>
                {request.fileCount} file · {request.changedLineCount} changed lines ·{" "}
                {request.additions} additions · {request.deletions} deletions
              </dd>
            </div>
            <div>
              <dt>Trace</dt>
              <dd>{request.traceId}</dd>
            </div>
            <div>
              <dt>File</dt>
              <dd>{request.path}</dd>
            </div>
            <div>
              <dt>Regression commit</dt>
              <dd>{request.regressionCommitSha}</dd>
            </div>
            <div>
              <dt>Source PR</dt>
              <dd>PR #{request.sourcePullRequestNumber}</dd>
            </div>
            <div>
              <dt>Source blob</dt>
              <dd>{request.expectedBlobSha}</dd>
            </div>
            <div>
              <dt>Proposal fingerprint</dt>
              <dd>{request.proposalFingerprint}</dd>
            </div>
          </dl>
          <h3>Exact bounded diff</h3>
          <p>Current evidenced source</p>
          <pre>
            <code>{request.currentContent}</code>
          </pre>
          <p>Proposed replacement</p>
          <pre>
            <code>{request.replacementContent}</code>
          </pre>
          <p>
            Approval permits one guarded draft-PR action. It does not permit merge, deploy, or
            rollback.
          </p>
          <div className="approval-actions">
            <button type="button" onClick={() => onDecision(request.approvalId, true)}>
              Approve draft PR
            </button>
            <button type="button" onClick={() => onDecision(request.approvalId, false)}>
              Reject
            </button>
          </div>
        </article>
      ))}
    </section>
  );
}
