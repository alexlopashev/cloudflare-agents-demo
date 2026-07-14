PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS release_preview_evidence (
  release_id TEXT NOT NULL CHECK (length(release_id) BETWEEN 1 AND 128),
  base_sha TEXT NOT NULL CHECK (
    base_sha GLOB '[0-9a-f]*'
    AND base_sha NOT GLOB '*[^0-9a-f]*'
    AND length(base_sha) = 40
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
  PRIMARY KEY (release_id, base_sha),
  FOREIGN KEY (release_id) REFERENCES release_source_evidence(release_id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS validate_release_preview_source_insert
BEFORE INSERT ON release_preview_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM release_source_evidence
  WHERE release_id = NEW.release_id
    AND source_path = NEW.source_path
    AND blob_sha = NEW.blob_sha
    AND byte_length = NEW.byte_length
    AND content = NEW.content
)
BEGIN
  SELECT RAISE(ABORT, 'Release preview evidence does not match its source receipt.');
END;

CREATE TRIGGER IF NOT EXISTS validate_release_preview_source_update
BEFORE UPDATE ON release_preview_evidence
WHEN NOT EXISTS (
  SELECT 1 FROM release_source_evidence
  WHERE release_id = NEW.release_id
    AND source_path = NEW.source_path
    AND blob_sha = NEW.blob_sha
    AND byte_length = NEW.byte_length
    AND content = NEW.content
)
BEGIN
  SELECT RAISE(ABORT, 'Release preview evidence does not match its source receipt.');
END;

CREATE TRIGGER IF NOT EXISTS reject_conflicting_release_preview
BEFORE UPDATE ON release_preview_evidence
WHEN OLD.base_sha IS NOT NEW.base_sha
  OR OLD.source_path IS NOT NEW.source_path
  OR OLD.blob_sha IS NOT NEW.blob_sha
  OR OLD.byte_length IS NOT NEW.byte_length
  OR OLD.content IS NOT NEW.content
BEGIN
  SELECT RAISE(ABORT, 'Release preview evidence is immutable.');
END;
