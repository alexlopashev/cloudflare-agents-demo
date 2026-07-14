PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS release_source_evidence (
  release_id TEXT PRIMARY KEY CHECK (length(release_id) BETWEEN 1 AND 128),
  commit_sha TEXT NOT NULL CHECK (commit_sha = 'd591869a8ef995f1835ef80152f4de085b10255b'),
  commit_subject TEXT NOT NULL CHECK (
    length(commit_subject) BETWEEN 1 AND 1024
    AND commit_subject LIKE '%(#19)'
  ),
  committed_at TEXT NOT NULL CHECK (length(committed_at) BETWEEN 20 AND 35),
  pull_request_number INTEGER NOT NULL CHECK (pull_request_number = 19),
  pull_request_head_sha TEXT NOT NULL CHECK (
    pull_request_head_sha = '9af361e5a9420323b2c86f2670e3bf812ac58620'
  ),
  source_path TEXT NOT NULL CHECK (source_path = 'workers/platform/src/api/health.ts'),
  blob_sha TEXT NOT NULL CHECK (
    blob_sha GLOB '[0-9a-f]*'
    AND blob_sha NOT GLOB '*[^0-9a-f]*'
    AND length(blob_sha) = 40
  ),
  byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 32768),
  content TEXT NOT NULL CHECK (
    length(CAST(content AS BLOB)) = byte_length
    AND byte_length BETWEEN 1 AND 32768
  ),
  FOREIGN KEY (release_id) REFERENCES releases(release_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS validate_release_source_attribution_insert
BEFORE INSERT ON release_source_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM releases
  WHERE release_id = NEW.release_id AND git_sha = NEW.commit_sha
)
BEGIN
  SELECT RAISE(ABORT, 'Release source evidence does not match its release attribution.');
END;

CREATE TRIGGER IF NOT EXISTS validate_release_source_attribution_update
BEFORE UPDATE ON release_source_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM releases
  WHERE release_id = NEW.release_id AND git_sha = NEW.commit_sha
)
BEGIN
  SELECT RAISE(ABORT, 'Release source evidence does not match its release attribution.');
END;

CREATE TRIGGER IF NOT EXISTS reject_conflicting_release_source
BEFORE UPDATE ON release_source_evidence
WHEN OLD.commit_sha IS NOT NEW.commit_sha
  OR OLD.commit_subject IS NOT NEW.commit_subject
  OR OLD.committed_at IS NOT NEW.committed_at
  OR OLD.pull_request_number IS NOT NEW.pull_request_number
  OR OLD.pull_request_head_sha IS NOT NEW.pull_request_head_sha
  OR OLD.source_path IS NOT NEW.source_path
  OR OLD.blob_sha IS NOT NEW.blob_sha
  OR OLD.byte_length IS NOT NEW.byte_length
  OR OLD.content IS NOT NEW.content
BEGIN
  SELECT RAISE(ABORT, 'Release source evidence is immutable.');
END;
