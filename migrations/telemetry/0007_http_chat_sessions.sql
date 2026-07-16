CREATE TABLE IF NOT EXISTS http_chat_sessions (
  session_id TEXT PRIMARY KEY
    CHECK (session_id GLOB 'http-*' AND length(session_id) BETWEEN 15 AND 85),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL
    CHECK (updated_at_ms >= created_at_ms),
  message_count INTEGER NOT NULL CHECK (message_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_http_chat_sessions_updated
  ON http_chat_sessions(updated_at_ms DESC, session_id ASC);
