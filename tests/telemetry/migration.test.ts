import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationPath = new URL("../../migrations/telemetry/0002_telemetry.sql", import.meta.url);
const integrityMigrationPath = new URL(
  "../../migrations/telemetry/0003_telemetry_integrity.sql",
  import.meta.url,
);
const cleanupMigrationPath = new URL(
  "../../migrations/telemetry/0006_remove_platform_metadata.sql",
  import.meta.url,
);
const httpSessionMigrationPath = new URL(
  "../../migrations/telemetry/0007_http_chat_sessions.sql",
  import.meta.url,
);

describe("telemetry migration", () => {
  it("defines normalized release, interaction, trace, and span evidence", async () => {
    const sql = await readFile(migrationPath, "utf8");

    for (const table of ["releases", "ux_events", "traces", "spans"]) {
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\(`));
    }
    expect(sql).toContain("PRIMARY KEY (trace_id, span_id)");
    expect(sql).toContain("UNIQUE (interaction_id, metric_name)");
    expect(sql).toContain("FOREIGN KEY (trace_id) REFERENCES traces(trace_id)");
    expect(sql).toContain("CHECK (metric_name = 'service_grid_ready_ms')");
    expect(sql).toContain("CHECK (git_sha GLOB");
  });

  it("indexes every bounded investigation access path", async () => {
    const sql = await readFile(migrationPath, "utf8");

    expect(sql).toContain("idx_ux_events_release_recorded");
    expect(sql).toContain("idx_traces_release_started");
    expect(sql).toContain("idx_traces_duration");
    expect(sql).toContain("idx_spans_trace_started");
  });

  it("rejects conflicting identifier reuse and cross-trace UX attribution in D1", async () => {
    const sql = await readFile(integrityMigrationPath, "utf8");

    expect(sql).toContain("reject_conflicting_trace");
    expect(sql).toContain("reject_conflicting_span");
    expect(sql).toContain("reject_conflicting_ux_event");
    expect(sql).toContain("validate_ux_event_trace_insert");
    expect(sql).toContain("RAISE(ABORT");
  });

  it("removes the unused platform metadata table without touching evidence tables", async () => {
    const sql = await readFile(cleanupMigrationPath, "utf8");

    expect(sql.trim()).toBe("DROP TABLE IF EXISTS platform_metadata;");
  });

  it("registers bounded HTTP chat session summaries without copying Durable Object messages", async () => {
    const sql = await readFile(httpSessionMigrationPath, "utf8");

    expect(sql).toContain("CREATE TABLE IF NOT EXISTS http_chat_sessions");
    expect(sql).toContain("message_count INTEGER NOT NULL");
    expect(sql).toContain("idx_http_chat_sessions_updated");
    expect(sql).not.toContain("message_content");
  });
});
