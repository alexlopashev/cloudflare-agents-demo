import { describe, expect, it, vi } from "vitest";

import {
  handleHttpSessionRequest,
  type HttpSessionAgent,
  type HttpSessionRecord,
  type HttpSessionStore,
} from "../../workers/platform/src/http/sessions";

const firstUserMessage = {
  id: "message-1",
  role: "user",
  parts: [{ type: "text", text: "Investigate the latency regression." }],
};
const firstAssistantMessage = {
  id: "message-2",
  role: "assistant",
  parts: [{ type: "text", text: "The investigation is complete." }],
};
const followUpMessage = {
  id: "message-3",
  role: "user",
  parts: [{ type: "text", text: "What remains unknown?" }],
};

function createHarness(records: HttpSessionRecord[] = []) {
  const stored = new Map(records.map((record) => [record.id, record]));
  const register = vi.fn(async (record: HttpSessionRecord) => {
    stored.set(record.id, record);
  });
  const update = vi.fn(async (id: string, updatedAtMs: number, messageCount: number) => {
    const current = stored.get(id);
    if (current === undefined) throw new Error("missing session");
    stored.set(id, { ...current, updatedAtMs, messageCount });
  });
  const store: HttpSessionStore = {
    get: vi.fn(async (id) => stored.get(id) ?? null),
    list: vi.fn(async (limit) =>
      [...stored.values()]
        .sort((left, right) => right.updatedAtMs - left.updatedAtMs)
        .slice(0, limit),
    ),
    register,
    update,
  };
  const runTurn = vi.fn(async () => ({
    messages: [firstUserMessage, firstAssistantMessage],
  }));
  const getTranscript = vi.fn(async () => ({
    messages: [firstUserMessage, firstAssistantMessage],
  }));
  const agent: HttpSessionAgent = { getTranscript, runTurn };
  const getAgent = vi.fn(() => agent);

  return {
    agent,
    getAgent,
    getTranscript,
    handle(request: Request) {
      return handleHttpSessionRequest(request, {
        createSessionId: () => "http-1234567890",
        getAgent,
        now: () => 2_000,
        store,
      });
    },
    register,
    runTurn,
    store,
    update,
  };
}

describe("HTTP chat sessions", () => {
  it("lists only the requested number of newest HTTP session summaries", async () => {
    const harness = createHarness([
      { id: "http-older-session", createdAtMs: 1_000, updatedAtMs: 1_100, messageCount: 2 },
      { id: "http-newer-session", createdAtMs: 1_200, updatedAtMs: 1_300, messageCount: 4 },
    ]);

    const response = await harness.handle(new Request("https://example.test/api/sessions?limit=1"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      sessions: [
        {
          id: "http-newer-session",
          createdAtMs: 1_200,
          updatedAtMs: 1_300,
          messageCount: 4,
        },
      ],
    });
    expect(harness.store.list).toHaveBeenCalledExactlyOnceWith(1);
    expect(harness.getAgent).not.toHaveBeenCalled();
  });

  it.each(["0", "101", "1.5", "many"])("rejects the invalid list limit %s", async (limit) => {
    const harness = createHarness();

    const response = await harness.handle(
      new Request(`https://example.test/api/sessions?limit=${limit}`),
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: { code: "invalid-request" } });
    expect(harness.store.list).not.toHaveBeenCalled();
  });

  it("creates a server-named session and returns its complete persisted transcript", async () => {
    const harness = createHarness();

    const response = await harness.handle(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "  Investigate the latency regression.  " }),
      }),
    );

    expect(response.status).toBe(201);
    expect(response.headers.get("location")).toBe("/api/sessions/http-1234567890");
    expect(await response.json()).toEqual({
      session: {
        id: "http-1234567890",
        createdAtMs: 2_000,
        updatedAtMs: 2_000,
        messageCount: 2,
        messages: [firstUserMessage, firstAssistantMessage],
      },
    });
    expect(harness.getAgent).toHaveBeenCalledExactlyOnceWith("http-1234567890");
    expect(harness.runTurn).toHaveBeenCalledExactlyOnceWith("Investigate the latency regression.");
    expect(harness.register).toHaveBeenCalledExactlyOnceWith({
      id: "http-1234567890",
      createdAtMs: 2_000,
      updatedAtMs: 2_000,
      messageCount: 2,
    });
  });

  it("appends a follow-up only to a registered session", async () => {
    const existing = {
      id: "http-existing-session",
      createdAtMs: 1_000,
      updatedAtMs: 1_100,
      messageCount: 2,
    };
    const harness = createHarness([existing]);
    harness.runTurn.mockResolvedValueOnce({
      messages: [firstUserMessage, firstAssistantMessage, followUpMessage],
    });

    const response = await harness.handle(
      new Request("https://example.test/api/sessions/http-existing-session/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "What remains unknown?" }),
      }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: {
        ...existing,
        updatedAtMs: 2_000,
        messageCount: 3,
        messages: [firstUserMessage, firstAssistantMessage, followUpMessage],
      },
    });
    expect(harness.getAgent).toHaveBeenCalledExactlyOnceWith("http-existing-session");
    expect(harness.runTurn).toHaveBeenCalledExactlyOnceWith("What remains unknown?");
    expect(harness.update).toHaveBeenCalledExactlyOnceWith("http-existing-session", 2_000, 3);

    const missing = await harness.handle(
      new Request("https://example.test/api/sessions/http-missing-session/messages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Continue." }),
      }),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "session-not-found" } });
    expect(harness.getAgent).toHaveBeenCalledOnce();
  });

  it("returns one registered session with every persisted chat message", async () => {
    const existing = {
      id: "http-existing-session",
      createdAtMs: 1_000,
      updatedAtMs: 1_100,
      messageCount: 2,
    };
    const harness = createHarness([existing]);

    const response = await harness.handle(
      new Request("https://example.test/api/sessions/http-existing-session"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      session: {
        ...existing,
        messages: [firstUserMessage, firstAssistantMessage],
      },
    });
    expect(harness.getTranscript).toHaveBeenCalledOnce();

    const missing = await harness.handle(
      new Request("https://example.test/api/sessions/http-missing-session"),
    );
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: "session-not-found" } });
    expect(harness.getTranscript).toHaveBeenCalledOnce();
  });

  it("fails closed instead of serializing an oversized transcript", async () => {
    const existing = {
      id: "http-existing-session",
      createdAtMs: 1_000,
      updatedAtMs: 1_100,
      messageCount: 2,
    };
    const harness = createHarness([existing]);
    harness.getTranscript.mockResolvedValueOnce({
      messages: [
        {
          id: "oversized-message",
          role: "assistant",
          parts: [{ type: "text", text: "x".repeat(600_000) }],
        },
      ],
    });

    const response = await harness.handle(
      new Request("https://example.test/api/sessions/http-existing-session"),
    );

    expect(response.status).toBe(413);
    expect(await response.json()).toEqual({ error: { code: "session-transcript-too-large" } });
  });

  it("fails closed on malformed message requests and agent failures", async () => {
    const harness = createHarness();
    const wrongMediaType = await harness.handle(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        body: JSON.stringify({ message: "Investigate." }),
      }),
    );
    expect(wrongMediaType.status).toBe(415);

    const whitespace = await harness.handle(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "   " }),
      }),
    );
    expect(whitespace.status).toBe(400);

    const extraField = await harness.handle(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Investigate.", session: "chosen-by-caller" }),
      }),
    );
    expect(extraField.status).toBe(400);

    const tooLarge = await harness.handle(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: { "content-length": "9000", "content-type": "application/json" },
        body: JSON.stringify({ message: "Investigate." }),
      }),
    );
    expect(tooLarge.status).toBe(413);

    harness.runTurn.mockRejectedValueOnce(new Error("private provider failure"));
    const unavailable = await harness.handle(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Investigate." }),
      }),
    );
    expect(unavailable.status).toBe(503);
    const unavailableBody = await unavailable.json();
    expect(unavailableBody).toEqual({ error: { code: "session-turn-failed" } });
    expect(JSON.stringify(unavailableBody)).not.toContain("private provider failure");
    expect(harness.register).not.toHaveBeenCalled();

    harness.runTurn.mockRejectedValueOnce(
      new Error("Public investigator limit reached. Retry in 60 seconds."),
    );
    const rateLimited = await harness.handle(
      new Request("https://example.test/api/sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Investigate." }),
      }),
    );
    expect(rateLimited.status).toBe(429);
    expect(rateLimited.headers.get("retry-after")).toBe("60");
    expect(await rateLimited.json()).toEqual({
      error: { code: "public-usage-rate-limited" },
    });
  });

  it("rejects unsupported methods and non-HTTP session identifiers", async () => {
    const harness = createHarness();

    const wrongCollectionMethod = await harness.handle(
      new Request("https://example.test/api/sessions", { method: "DELETE" }),
    );
    expect(wrongCollectionMethod.status).toBe(405);
    expect(wrongCollectionMethod.headers.get("allow")).toBe("GET, POST");

    const wrongDetailMethod = await harness.handle(
      new Request("https://example.test/api/sessions/http-existing-session", { method: "POST" }),
    );
    expect(wrongDetailMethod.status).toBe(405);
    expect(wrongDetailMethod.headers.get("allow")).toBe("GET");

    const browserSession = await harness.handle(
      new Request("https://example.test/api/sessions/browser-private-session"),
    );
    expect(browserSession.status).toBe(404);
    expect(harness.store.get).not.toHaveBeenCalled();
  });
});
