import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { createHttpSessionStore } from "../../workers/platform/src/http/sessions";
import type { PlatformEnvironment } from "../../workers/platform/src/index";

declare global {
  namespace Cloudflare {
    interface Env extends PlatformEnvironment {}
  }
}

describe("D1 HTTP session registry", () => {
  beforeEach(async () => {
    await env.TELEMETRY_DB.exec(
      `DROP TABLE IF EXISTS http_chat_sessions;
       CREATE TABLE http_chat_sessions (
         session_id TEXT PRIMARY KEY,
         created_at_ms INTEGER NOT NULL,
         updated_at_ms INTEGER NOT NULL,
         message_count INTEGER NOT NULL
       );`.replace(/\s+/g, " "),
    );
  });

  it("registers, updates, reads, and newest-first lists bounded session summaries", async () => {
    const store = createHttpSessionStore(env.TELEMETRY_DB);
    await store.register({
      id: "http-older-session",
      createdAtMs: 1_000,
      updatedAtMs: 1_100,
      messageCount: 2,
    });
    await store.register({
      id: "http-newer-session",
      createdAtMs: 1_200,
      updatedAtMs: 1_300,
      messageCount: 4,
    });

    await store.update("http-older-session", 1_400, 6);

    await expect(store.get("http-older-session")).resolves.toEqual({
      id: "http-older-session",
      createdAtMs: 1_000,
      updatedAtMs: 1_400,
      messageCount: 6,
    });
    await expect(store.list(1)).resolves.toEqual([
      {
        id: "http-older-session",
        createdAtMs: 1_000,
        updatedAtMs: 1_400,
        messageCount: 6,
      },
    ]);
  });

  it("rejects invalid identifiers, bounds, and updates of missing sessions", async () => {
    const store = createHttpSessionStore(env.TELEMETRY_DB);

    await expect(
      store.register({
        id: "browser-not-http",
        createdAtMs: 1_000,
        updatedAtMs: 1_000,
        messageCount: 0,
      }),
    ).rejects.toThrow("HTTP session identifier is invalid");
    await expect(store.list(101)).rejects.toThrow("HTTP session list limit is invalid");
    await expect(store.update("http-missing-session", 1_000, 1)).rejects.toThrow(
      "HTTP session does not exist",
    );
  });
});
