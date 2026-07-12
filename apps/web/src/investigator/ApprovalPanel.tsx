export type ApprovalRequest = {
  approvalId: string;
  toolCallId: string;
  title: string;
  path: string;
  traceId: string;
};

type ApprovalMessage = { id: string; parts: readonly unknown[] };

function property(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

function stringProperty(value: object, name: string): string | undefined {
  const candidate = property(value, name);
  return typeof candidate === "string" ? candidate : undefined;
}

export function buildApprovalRequests(messages: readonly ApprovalMessage[]): ApprovalRequest[] {
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
      const traceId = stringProperty(incident, "traceId");
      if (
        approvalId === undefined ||
        toolCallId === undefined ||
        title === undefined ||
        path === undefined ||
        traceId === undefined
      ) {
        continue;
      }
      requests.push({ approvalId, toolCallId, title, path, traceId });
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
          <dl>
            <div>
              <dt>Trace</dt>
              <dd>{request.traceId}</dd>
            </div>
            <div>
              <dt>Only file</dt>
              <dd>{request.path}</dd>
            </div>
          </dl>
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
