import { z } from "zod";

import { PUBLIC_USAGE_RETRY_AFTER_SECONDS } from "../public-usage";
import { readBoundedRequestText } from "./bounded-request";

export type HttpSessionRecord = {
  id: string;
  createdAtMs: number;
  updatedAtMs: number;
  messageCount: number;
};

export type HttpSessionStore = {
  get(id: string): Promise<HttpSessionRecord | null>;
  list(limit: number): Promise<HttpSessionRecord[]>;
  register(record: HttpSessionRecord): Promise<void>;
  update(id: string, updatedAtMs: number, messageCount: number): Promise<void>;
};

export type HttpSessionAgent = {
  getTranscript(): Promise<{ messages: unknown[] }>;
  runTurn(message: string): Promise<{ messages: unknown[] }>;
};

export type HttpSessionRequestOptions = {
  createSessionId(): string;
  getAgent(id: string): HttpSessionAgent;
  now(): number;
  store: HttpSessionStore;
};

const sessionIdPattern = /^http-[A-Za-z0-9-]{10,80}$/;
const defaultListLimit = 50;
const maximumListLimit = 100;
const maximumRequestBytes = 8_192;
const maximumTranscriptBytes = 512 * 1_024;
const messageSchema = z.object({ message: z.string().trim().min(1).max(4_000) }).strict();

export function normalizeHttpSessionMessage(value: unknown): string {
  const parsed = messageSchema.safeParse({ message: value });
  if (!parsed.success) throw new TypeError("HTTP session message is invalid.");
  return parsed.data.message;
}

function requireSessionId(id: string): void {
  if (!sessionIdPattern.test(id)) throw new TypeError("HTTP session identifier is invalid.");
}

function requireTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${label} is invalid.`);
}

function requireMessageCount(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("HTTP session message count is invalid.");
  }
}

function validateRecord(record: HttpSessionRecord): void {
  requireSessionId(record.id);
  requireTimestamp(record.createdAtMs, "HTTP session creation time");
  requireTimestamp(record.updatedAtMs, "HTTP session update time");
  requireMessageCount(record.messageCount);
  if (record.updatedAtMs < record.createdAtMs) {
    throw new TypeError("HTTP session update time is invalid.");
  }
}

function rowToRecord(row: {
  session_id: string;
  created_at_ms: number;
  updated_at_ms: number;
  message_count: number;
}): HttpSessionRecord {
  const record = {
    id: row.session_id,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
    messageCount: row.message_count,
  };
  validateRecord(record);
  return record;
}

export function createHttpSessionStore(database: D1Database): HttpSessionStore {
  return {
    async get(id) {
      requireSessionId(id);
      const row = await database
        .prepare(
          `SELECT session_id, created_at_ms, updated_at_ms, message_count
           FROM http_chat_sessions WHERE session_id = ?1 LIMIT 1`,
        )
        .bind(id)
        .first<{
          session_id: string;
          created_at_ms: number;
          updated_at_ms: number;
          message_count: number;
        }>();
      return row === null ? null : rowToRecord(row);
    },

    async list(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumListLimit) {
        throw new TypeError("HTTP session list limit is invalid.");
      }
      const result = await database
        .prepare(
          `SELECT session_id, created_at_ms, updated_at_ms, message_count
           FROM http_chat_sessions
           ORDER BY updated_at_ms DESC, session_id ASC
           LIMIT ?1`,
        )
        .bind(limit)
        .all<{
          session_id: string;
          created_at_ms: number;
          updated_at_ms: number;
          message_count: number;
        }>();
      return result.results.map(rowToRecord);
    },

    async register(record) {
      validateRecord(record);
      await database
        .prepare(
          `INSERT INTO http_chat_sessions
             (session_id, created_at_ms, updated_at_ms, message_count)
           VALUES (?1, ?2, ?3, ?4)`,
        )
        .bind(record.id, record.createdAtMs, record.updatedAtMs, record.messageCount)
        .run();
    },

    async update(id, updatedAtMs, messageCount) {
      requireSessionId(id);
      requireTimestamp(updatedAtMs, "HTTP session update time");
      requireMessageCount(messageCount);
      const result = await database
        .prepare(
          `UPDATE http_chat_sessions
           SET updated_at_ms = ?2, message_count = ?3
           WHERE session_id = ?1 AND created_at_ms <= ?2`,
        )
        .bind(id, updatedAtMs, messageCount)
        .run();
      if (result.meta.changes !== 1) throw new Error("HTTP session does not exist.");
    },
  };
}

function errorResponse(status: number, code: string, headers: HeadersInit = {}): Response {
  return Response.json(
    { error: { code } },
    { status, headers: { "cache-control": "no-store", ...headers } },
  );
}

function jsonResponse(
  status: number,
  record: HttpSessionRecord,
  messages: unknown[],
  headers: HeadersInit = {},
): Response {
  const session = { ...record, messageCount: messages.length, messages };
  const body = JSON.stringify({ session });
  if (new TextEncoder().encode(body).byteLength > maximumTranscriptBytes) {
    return errorResponse(413, "session-transcript-too-large");
  }
  return new Response(body, {
    status,
    headers: {
      "cache-control": "no-store",
      "content-type": "application/json",
      ...headers,
    },
  });
}

function parseListLimit(url: URL): number | null {
  const raw = url.searchParams.get("limit");
  if (raw === null) return defaultListLimit;
  if (!/^(?:[1-9]|[1-9]\d|100)$/.test(raw)) return null;
  return Number.parseInt(raw, 10);
}

async function readMessage(
  request: Request,
): Promise<{ ok: true; message: string } | { ok: false; response: Response }> {
  const mediaType = (request.headers.get("content-type") ?? "")
    .split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return { ok: false, response: errorResponse(415, "unsupported-media-type") };
  }
  let text: string;
  try {
    text = await readBoundedRequestText(request, maximumRequestBytes);
  } catch (error) {
    return {
      ok: false,
      response: errorResponse(error instanceof RangeError ? 413 : 400, "invalid-request"),
    };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    return { ok: false, response: errorResponse(400, "invalid-request") };
  }
  const parsed = messageSchema.safeParse(payload);
  if (!parsed.success) {
    return { ok: false, response: errorResponse(400, "invalid-request") };
  }
  return { ok: true, message: normalizeHttpSessionMessage(parsed.data.message) };
}

async function getRecord(
  store: HttpSessionStore,
  id: string,
): Promise<{ ok: true; record: HttpSessionRecord | null } | { ok: false; response: Response }> {
  try {
    return { ok: true, record: await store.get(id) };
  } catch {
    return { ok: false, response: errorResponse(503, "session-store-unavailable") };
  }
}

async function runAgentTurn(
  agent: HttpSessionAgent,
  message: string,
): Promise<{ ok: true; messages: unknown[] } | { ok: false; response: Response }> {
  try {
    const result = await agent.runTurn(message);
    if (!Array.isArray(result.messages)) throw new TypeError("Invalid transcript.");
    return { ok: true, messages: result.messages };
  } catch (error) {
    if (
      error instanceof Error &&
      error.message ===
        `Public investigator limit reached. Retry in ${PUBLIC_USAGE_RETRY_AFTER_SECONDS} seconds.`
    ) {
      return {
        ok: false,
        response: errorResponse(429, "public-usage-rate-limited", {
          "retry-after": String(PUBLIC_USAGE_RETRY_AFTER_SECONDS),
        }),
      };
    }
    return { ok: false, response: errorResponse(503, "session-turn-failed") };
  }
}

export async function handleHttpSessionRequest(
  request: Request,
  options: HttpSessionRequestOptions,
): Promise<Response> {
  const url = new URL(request.url);
  if (url.pathname === "/api/sessions") {
    if (request.method === "GET") {
      const limit = parseListLimit(url);
      if (limit === null) return errorResponse(400, "invalid-request");
      try {
        return Response.json(
          { sessions: await options.store.list(limit) },
          { headers: { "cache-control": "no-store" } },
        );
      } catch {
        return errorResponse(503, "session-store-unavailable");
      }
    }
    if (request.method !== "POST") {
      return errorResponse(405, "method-not-allowed", { allow: "GET, POST" });
    }
    const parsed = await readMessage(request);
    if (!parsed.ok) return parsed.response;
    const id = options.createSessionId();
    try {
      requireSessionId(id);
    } catch {
      return errorResponse(503, "session-creation-failed");
    }
    const turn = await runAgentTurn(options.getAgent(id), parsed.message);
    if (!turn.ok) return turn.response;
    const timestamp = options.now();
    const record = {
      id,
      createdAtMs: timestamp,
      updatedAtMs: timestamp,
      messageCount: turn.messages.length,
    };
    try {
      await options.store.register(record);
    } catch {
      return errorResponse(503, "session-store-unavailable");
    }
    return jsonResponse(201, record, turn.messages, { location: `/api/sessions/${id}` });
  }

  const match = /^\/api\/sessions\/(http-[A-Za-z0-9-]{10,80})(\/messages)?$/.exec(url.pathname);
  if (match === null) return errorResponse(404, "not-found");
  const id = match[1];
  if (id === undefined) return errorResponse(404, "not-found");
  const isMessages = match[2] === "/messages";
  if ((!isMessages && request.method !== "GET") || (isMessages && request.method !== "POST")) {
    return errorResponse(405, "method-not-allowed", { allow: isMessages ? "POST" : "GET" });
  }
  const current = await getRecord(options.store, id);
  if (!current.ok) return current.response;
  if (current.record === null) return errorResponse(404, "session-not-found");

  if (isMessages) {
    const parsed = await readMessage(request);
    if (!parsed.ok) return parsed.response;
    const turn = await runAgentTurn(options.getAgent(id), parsed.message);
    if (!turn.ok) return turn.response;
    const updatedAtMs = options.now();
    try {
      await options.store.update(id, updatedAtMs, turn.messages.length);
    } catch {
      return errorResponse(503, "session-store-unavailable");
    }
    return jsonResponse(
      200,
      { ...current.record, updatedAtMs, messageCount: turn.messages.length },
      turn.messages,
    );
  }

  try {
    const result = await options.getAgent(id).getTranscript();
    if (!Array.isArray(result.messages)) throw new TypeError("Invalid transcript.");
    return jsonResponse(200, current.record, result.messages);
  } catch {
    return errorResponse(503, "session-read-failed");
  }
}
