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
  proposal: {
    expectedBlobSha: string;
    incident: {
      regressionCommitSha: string;
      sourcePullRequestNumber: number;
      traceId: string;
    };
    path: string;
    rationale: string;
    replacementContent: string;
    title: string;
  };
  diff: {
    additions: number;
    currentContent: string;
    deletions: number;
    path: string;
    replacementContent: string;
  };
};

type ApprovalMessage = { id: string; parts: readonly unknown[]; role?: string };

export type ApprovalDecision = {
  approved: boolean;
  request: ApprovalRequest;
  state: "submitting" | "failed";
};

export type ApprovalOutcome = {
  message: string;
  state: "submitting" | "rejected" | "preview" | "created" | "reused" | "failed";
  number?: number;
  url?: string;
};

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
      const approvalId = stringProperty(approval, "id");
      const toolCallId = stringProperty(part, "toolCallId");
      const proposalFingerprint = stringProperty(input, "proposalFingerprint");
      if (
        approvalId === undefined ||
        toolCallId === undefined ||
        proposalFingerprint === undefined ||
        prepared === undefined ||
        prepared.fingerprint !== proposalFingerprint ||
        prepared.diff.path !== prepared.proposal.path ||
        prepared.diff.replacementContent !== prepared.proposal.replacementContent ||
        positiveIntegerProperty(prepared.proposal.incident, "sourcePullRequestNumber") === undefined
      ) {
        continue;
      }
      const { proposal } = prepared;
      requests.push({
        additions: prepared.diff.additions,
        approvalId,
        changedLineCount: prepared.diff.additions + prepared.diff.deletions,
        currentContent: prepared.diff.currentContent,
        deletions: prepared.diff.deletions,
        expectedBlobSha: proposal.expectedBlobSha,
        fileCount: 1,
        toolCallId,
        title: proposal.title,
        path: proposal.path,
        proposalFingerprint,
        rationale: proposal.rationale,
        regressionCommitSha: proposal.incident.regressionCommitSha,
        replacementContent: proposal.replacementContent,
        sourcePullRequestNumber: proposal.incident.sourcePullRequestNumber,
        traceId: proposal.incident.traceId,
        writePosture: prepared.writeEnabled
          ? "Live draft-PR writes enabled"
          : "Preview only — external GitHub writes disabled",
      });
    }
  }
  return requests;
}

export function buildCompactDiff(currentContent: string, replacementContent: string): string {
  const current = currentContent.split("\n");
  const replacement = replacementContent.split("\n");
  let prefix = 0;
  while (prefix < current.length && current[prefix] === replacement[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < current.length - prefix &&
    suffix < replacement.length - prefix &&
    current[current.length - suffix - 1] === replacement[replacement.length - suffix - 1]
  ) {
    suffix += 1;
  }
  if (prefix === current.length && prefix === replacement.length) {
    throw new TypeError("Approval diff requires a source change.");
  }
  const contextLines = 2;
  const start = Math.max(0, prefix - contextLines);
  const currentChangeEnd = current.length - suffix;
  const replacementChangeEnd = replacement.length - suffix;
  const currentEnd = Math.min(current.length, currentChangeEnd + contextLines);
  const replacementEnd = Math.min(replacement.length, replacementChangeEnd + contextLines);
  return [
    `@@ -${start + 1},${currentEnd - start} +${start + 1},${replacementEnd - start} @@`,
    ...current.slice(start, prefix).map((line) => ` ${line}`),
    ...current.slice(prefix, currentChangeEnd).map((line) => `-${line}`),
    ...replacement.slice(prefix, replacementChangeEnd).map((line) => `+${line}`),
    ...current.slice(currentChangeEnd, currentEnd).map((line) => ` ${line}`),
  ].join("\n");
}

function lastActionPart(messages: readonly ApprovalMessage[]): object | undefined {
  for (let messageIndex = messages.length - 1; messageIndex >= 0; messageIndex -= 1) {
    const message = messages[messageIndex];
    if (message === undefined) continue;
    for (let partIndex = message.parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = message.parts[partIndex];
      if (
        part !== null &&
        typeof part === "object" &&
        stringProperty(part, "type") === "tool-create_draft_pr"
      ) {
        return part;
      }
    }
  }
  return undefined;
}

function messagesForLatestUserTurn(
  messages: readonly ApprovalMessage[],
): readonly ApprovalMessage[] {
  const start = messages.findLastIndex((message) => message.role === "user");
  return start < 0 ? messages : messages.slice(start);
}

const boundedGitHubFailurePattern =
  /^GitHub (?:read-base-ref|read-base-commit|read-source-file|find-draft-pr|read-remediation-branch|compare-remediation-branch|create-blob|create-tree|create-commit|create-branch|create-draft-pr) failed (?:before a response|with HTTP [1-5][0-9]{2})\. No draft PR was confirmed\. Retry requires a new approval\.$/;

function boundedActionFailure(part: object): string | undefined {
  let candidate = stringProperty(part, "errorText");
  const output = property(part, "output");
  if (output !== null && typeof output === "object") {
    const error = property(output, "error");
    if (error !== null && typeof error === "object") {
      candidate = stringProperty(error, "message") ?? candidate;
    }
  }
  return candidate !== undefined && boundedGitHubFailurePattern.test(candidate)
    ? candidate
    : undefined;
}

function createdPullRequestOutcome(output: object): ApprovalOutcome | undefined {
  const status = stringProperty(output, "status");
  const number = positiveIntegerProperty(output, "number");
  const repository = stringProperty(output, "repository");
  const url = stringProperty(output, "url");
  if (
    (status !== "created" && status !== "reused") ||
    number === undefined ||
    repository === undefined ||
    !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) ||
    url === undefined
  ) {
    return undefined;
  }
  try {
    const parsed = new URL(url);
    if (
      parsed.protocol !== "https:" ||
      parsed.hostname !== "github.com" ||
      parsed.username !== "" ||
      parsed.password !== "" ||
      parsed.port !== "" ||
      parsed.search !== "" ||
      parsed.hash !== "" ||
      parsed.pathname !== `/${repository}/pull/${number}` ||
      property(output, "draft") !== true ||
      (status === "created" && property(output, "writesPerformed") !== true) ||
      (status === "reused" && property(output, "writesPerformed") !== false)
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return {
    message: `Draft PR #${number} ${status}.`,
    number,
    state: status,
    url,
  };
}

export function buildApprovalOutcome(
  messages: readonly ApprovalMessage[],
  decision?: ApprovalDecision,
): ApprovalOutcome | undefined {
  const currentTurnMessages = messagesForLatestUserTurn(messages);
  const successfulPart = currentTurnMessages.findLast((message) =>
    message.parts.some((candidate) => {
      if (
        candidate === null ||
        typeof candidate !== "object" ||
        stringProperty(candidate, "type") !== "tool-create_draft_pr" ||
        stringProperty(candidate, "state") !== "output-available"
      ) {
        return false;
      }
      const output = property(candidate, "output");
      if (output === null || typeof output !== "object") return false;
      return (
        (stringProperty(output, "status") === "preview" &&
          property(output, "writesPerformed") === false) ||
        createdPullRequestOutcome(output) !== undefined
      );
    }),
  );
  const part =
    successfulPart === undefined
      ? lastActionPart(currentTurnMessages)
      : lastActionPart([successfulPart]);
  const state = part === undefined ? undefined : stringProperty(part, "state");
  const boundedFailure = part === undefined ? undefined : boundedActionFailure(part);
  if (state === "output-denied") {
    return { message: "Proposal rejected. No GitHub write was performed.", state: "rejected" };
  }
  if (state === "output-error") {
    if (boundedFailure !== undefined) return { message: boundedFailure, state: "failed" };
    return { message: "Draft PR action failed safely. Retrying is safe.", state: "failed" };
  }
  if (state === "output-available" && part !== undefined) {
    const output = property(part, "output");
    if (output !== null && typeof output === "object") {
      if (
        stringProperty(output, "status") === "preview" &&
        property(output, "writesPerformed") === false
      ) {
        return {
          message: "Preview complete. No GitHub write was performed.",
          state: "preview",
        };
      }
      const pullRequest = createdPullRequestOutcome(output);
      if (pullRequest !== undefined) return pullRequest;
    }
    if (boundedFailure !== undefined) return { message: boundedFailure, state: "failed" };
    return { message: "Draft PR action stopped safely. Retrying is safe.", state: "failed" };
  }
  if (state === "approval-responded" && part !== undefined) {
    const approval = property(part, "approval");
    if (approval !== null && typeof approval === "object") {
      if (property(approval, "approved") === false) {
        return { message: "Proposal rejected. No GitHub write was performed.", state: "rejected" };
      }
      if (property(approval, "approved") === true) {
        return { message: "Running the guarded draft PR action…", state: "submitting" };
      }
    }
  }
  if (decision === undefined) return undefined;
  if (decision.state === "failed") {
    return { message: "Could not submit the decision. Retrying is safe.", state: "failed" };
  }
  if (!decision.approved) {
    return { message: "Proposal rejected. No GitHub write was performed.", state: "rejected" };
  }
  return {
    message:
      decision.request.writePosture === "Live draft-PR writes enabled"
        ? "Creating the guarded draft PR…"
        : "Running the guarded draft PR preview…",
    state: "submitting",
  };
}

export async function startApprovalDecision(input: {
  approved: boolean;
  dispatch(args: { id: string; approved: boolean }): void | PromiseLike<void>;
  request: ApprovalRequest;
  update(decision: ApprovalDecision): void;
}): Promise<void> {
  const decision: ApprovalDecision = {
    approved: input.approved,
    request: input.request,
    state: "submitting",
  };
  input.update(decision);
  try {
    await input.dispatch({ id: input.request.approvalId, approved: input.approved });
  } catch {
    input.update({ ...decision, state: "failed" });
  }
}

function ApprovalResult({ outcome }: { outcome: ApprovalOutcome }) {
  return (
    <p className={`approval-result ${outcome.state}`} role="status">
      {outcome.message}
      {outcome.url !== undefined && (
        <>
          {" "}
          <a href={outcome.url} rel="noreferrer" target="_blank">
            Open draft PR
          </a>
        </>
      )}
    </p>
  );
}

export function ApprovalPanel({
  requests,
  outcome,
  onDecision,
}: {
  requests: readonly ApprovalRequest[];
  outcome?: ApprovalOutcome;
  onDecision(request: ApprovalRequest, approved: boolean): void;
}) {
  if (requests.length === 0 && outcome === undefined) return null;
  return (
    <section className="message assistant approval-panel" aria-label="Draft pull request approval">
      <p className="eyebrow">
        {requests.length === 0 ? "Draft PR action" : "Human approval required"}
      </p>
      {requests.length === 0 && outcome !== undefined && <ApprovalResult outcome={outcome} />}
      {requests.map((request) => (
        <article key={request.approvalId}>
          <h2>{request.title}</h2>
          <p className="write-posture">{request.writePosture}</p>
          {outcome !== undefined && <ApprovalResult outcome={outcome} />}
          <div className="approval-actions">
            <button
              disabled={outcome !== undefined}
              type="button"
              onClick={() => onDecision(request, true)}
            >
              {request.writePosture === "Live draft-PR writes enabled"
                ? "Create Draft PR"
                : "Preview Draft PR"}
            </button>
            <button
              disabled={outcome !== undefined}
              type="button"
              onClick={() => onDecision(request, false)}
            >
              Reject
            </button>
          </div>
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
          </dl>
          <p>
            Approval permits one guarded draft-PR action. It does not permit merge, deploy, or
            rollback.
          </p>
          <details className="approval-diff">
            <summary>
              Review exact change · {request.additions} additions, {request.deletions} deletions
            </summary>
            <pre>
              <code>{buildCompactDiff(request.currentContent, request.replacementContent)}</code>
            </pre>
          </details>
          <details className="approval-evidence">
            <summary>Evidence anchors</summary>
            <dl>
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
                <dt>Fingerprint</dt>
                <dd>{request.proposalFingerprint}</dd>
              </div>
            </dl>
          </details>
        </article>
      ))}
    </section>
  );
}
