type ProtocolFetcher = {
  fetch(input: Request): Promise<Response>;
};

type ProtocolFrame = Record<string, unknown>;

function records(value: unknown): ProtocolFrame[] {
  if (typeof value === "string") {
    try {
      return records(JSON.parse(value) as unknown);
    } catch {
      return [];
    }
  }
  if (Array.isArray(value)) return value.flatMap(records);
  if (typeof value !== "object" || value === null) return [];
  const record = value as ProtocolFrame;
  return [record, ...Object.values(record).flatMap(records)];
}

function actionPart(value: unknown, state: string): ProtocolFrame | undefined {
  return records(value).find(
    (record) =>
      record.type === "tool-create_draft_pr" &&
      record.state === state &&
      typeof record.toolCallId === "string",
  );
}

function diagnosticFrames(frames: unknown[]): unknown[] {
  return frames
    .flatMap(records)
    .filter(
      (record) =>
        typeof record.type === "string" &&
        (record.type.startsWith("cf_agent_") || record.type === "tool-create_draft_pr"),
    )
    .slice(-20)
    .map((record) => ({
      type: record.type,
      ...(typeof record.state === "string" ? { state: record.state } : {}),
      ...(typeof record.toolCallId === "string" ? { toolCallId: record.toolCallId } : {}),
    }));
}

export type AgentChatProtocol = {
  close(): void;
  requestResume(): void;
  sendApproval(toolCallId: string, approved: boolean): void;
  sendTurn(requestId: string, text: string): void;
  waitForActionResult(): Promise<void>;
  waitForApproval(): Promise<{ toolCallId: string }>;
};

export async function openAgentChatProtocol(
  fetcher: ProtocolFetcher,
  path: string,
): Promise<AgentChatProtocol> {
  const response = await fetcher.fetch(
    new Request(`https://example.test${path}`, { headers: { Upgrade: "websocket" } }),
  );
  const socket = response.webSocket;
  if (response.status !== 101 || socket === null) {
    throw new Error(
      `Agent protocol upgrade failed with HTTP ${response.status}: ${await response.text()}`,
    );
  }
  socket.accept();
  const frames: unknown[] = [];
  const listeners = new Set<() => void>();
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      frames.push(JSON.parse(event.data) as unknown);
    } catch {
      frames.push(event.data);
    }
    for (const listener of listeners) listener();
  });

  const waitFor = async (predicate: (frame: unknown) => boolean): Promise<unknown> => {
    const existing = frames.find(predicate);
    if (existing !== undefined) return existing;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        listeners.delete(check);
        reject(
          new Error(`Agent protocol frame timed out: ${JSON.stringify(diagnosticFrames(frames))}`),
        );
      }, 20_000);
      const check = () => {
        const frame = frames.find(predicate);
        if (frame === undefined) return;
        clearTimeout(timeout);
        listeners.delete(check);
        resolve(frame);
      };
      listeners.add(check);
    });
  };

  return {
    close: () => socket.close(1000, "test reconnect"),
    requestResume: () => socket.send(JSON.stringify({ type: "cf_agent_stream_resume_request" })),
    sendApproval: (toolCallId, approved) =>
      socket.send(
        JSON.stringify({
          type: "cf_agent_tool_approval",
          toolCallId,
          approved,
          autoContinue: true,
        }),
      ),
    sendTurn: (requestId, text) =>
      socket.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: {
            method: "POST",
            body: JSON.stringify({
              messages: [
                {
                  id: `user-${requestId}`,
                  role: "user",
                  parts: [{ type: "text", text }],
                },
              ],
              trigger: "submit-message",
            }),
          },
        }),
      ),
    waitForActionResult: async () => {
      await waitFor((frame) => actionPart(frame, "output-available") !== undefined);
    },
    waitForApproval: async () => {
      const frame = await waitFor((candidate) =>
        Boolean(actionPart(candidate, "approval-requested")),
      );
      const part = actionPart(frame, "approval-requested");
      if (part === undefined || typeof part.toolCallId !== "string") {
        throw new Error("Agent protocol approval frame was malformed.");
      }
      return { toolCallId: part.toolCallId };
    },
  };
}
