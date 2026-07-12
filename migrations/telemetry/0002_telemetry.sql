PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS releases (
  release_id TEXT PRIMARY KEY CHECK (length(release_id) BETWEEN 1 AND 128),
  git_sha TEXT NOT NULL
    CHECK (git_sha GLOB '[0-9a-f]*' AND git_sha NOT GLOB '*[^0-9a-f]*' AND length(git_sha) = 40),
  deployed_at_ms INTEGER NOT NULL CHECK (deployed_at_ms >= 0)
);

CREATE TABLE IF NOT EXISTS traces (
  trace_id TEXT PRIMARY KEY CHECK (length(trace_id) BETWEEN 1 AND 128),
  interaction_id TEXT NOT NULL CHECK (length(interaction_id) BETWEEN 1 AND 128),
  release_id TEXT NOT NULL,
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  duration_ms REAL NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'error')),
  FOREIGN KEY (release_id) REFERENCES releases(release_id)
);

CREATE TABLE IF NOT EXISTS spans (
  trace_id TEXT NOT NULL,
  span_id TEXT NOT NULL CHECK (length(span_id) BETWEEN 1 AND 128),
  parent_span_id TEXT CHECK (parent_span_id IS NULL OR length(parent_span_id) BETWEEN 1 AND 128),
  service_id TEXT NOT NULL CHECK (length(service_id) BETWEEN 1 AND 80),
  started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
  duration_ms REAL NOT NULL CHECK (duration_ms >= 0),
  status TEXT NOT NULL CHECK (status IN ('success', 'error')),
  PRIMARY KEY (trace_id, span_id),
  FOREIGN KEY (trace_id) REFERENCES traces(trace_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ux_events (
  event_id INTEGER PRIMARY KEY AUTOINCREMENT,
  interaction_id TEXT NOT NULL CHECK (length(interaction_id) BETWEEN 1 AND 128),
  trace_id TEXT NOT NULL,
  release_id TEXT NOT NULL,
  metric_name TEXT NOT NULL CHECK (metric_name = 'service_grid_ready_ms'),
  duration_ms REAL NOT NULL CHECK (duration_ms >= 0),
  outcome TEXT NOT NULL CHECK (outcome IN ('success', 'partial', 'error')),
  recorded_at_ms INTEGER NOT NULL CHECK (recorded_at_ms >= 0),
  UNIQUE (interaction_id, metric_name),
  FOREIGN KEY (trace_id) REFERENCES traces(trace_id),
  FOREIGN KEY (release_id) REFERENCES releases(release_id)
);

CREATE INDEX IF NOT EXISTS idx_ux_events_release_recorded
  ON ux_events(release_id, recorded_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_traces_release_started
  ON traces(release_id, started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_traces_duration
  ON traces(duration_ms DESC, started_at_ms DESC);
CREATE INDEX IF NOT EXISTS idx_spans_trace_started
  ON spans(trace_id, started_at_ms, span_id);
