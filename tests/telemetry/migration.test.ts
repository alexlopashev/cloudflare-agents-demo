import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

const migrationPath = new URL("../../migrations/telemetry/0002_telemetry.sql", import.meta.url);

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
});
