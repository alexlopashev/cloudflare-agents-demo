CREATE TRIGGER IF NOT EXISTS reject_conflicting_release
BEFORE UPDATE ON releases
WHEN OLD.git_sha IS NOT NEW.git_sha
  OR OLD.deployed_at_ms IS NOT NEW.deployed_at_ms
BEGIN
  SELECT RAISE(ABORT, 'Release attribution is immutable.');
END;

CREATE TRIGGER IF NOT EXISTS reject_conflicting_trace
BEFORE UPDATE ON traces
WHEN OLD.interaction_id IS NOT NEW.interaction_id
  OR OLD.release_id IS NOT NEW.release_id
  OR OLD.started_at_ms IS NOT NEW.started_at_ms
  OR OLD.duration_ms IS NOT NEW.duration_ms
  OR OLD.outcome IS NOT NEW.outcome
BEGIN
  SELECT RAISE(ABORT, 'Trace identifier conflicts with persisted telemetry.');
END;

CREATE TRIGGER IF NOT EXISTS reject_conflicting_span
BEFORE UPDATE ON spans
WHEN OLD.parent_span_id IS NOT NEW.parent_span_id
  OR OLD.service_id IS NOT NEW.service_id
  OR OLD.started_at_ms IS NOT NEW.started_at_ms
  OR OLD.duration_ms IS NOT NEW.duration_ms
  OR OLD.status IS NOT NEW.status
BEGIN
  SELECT RAISE(ABORT, 'Span identifier conflicts with persisted telemetry.');
END;

CREATE TRIGGER IF NOT EXISTS validate_ux_event_trace_insert
BEFORE INSERT ON ux_events
WHEN NOT EXISTS (
  SELECT 1
  FROM traces
  WHERE trace_id = NEW.trace_id
    AND interaction_id = NEW.interaction_id
    AND release_id = NEW.release_id
)
BEGIN
  SELECT RAISE(ABORT, 'UX event attribution does not match its trace.');
END;

CREATE TRIGGER IF NOT EXISTS validate_ux_event_trace_update
BEFORE UPDATE ON ux_events
WHEN NOT EXISTS (
  SELECT 1
  FROM traces
  WHERE trace_id = NEW.trace_id
    AND interaction_id = NEW.interaction_id
    AND release_id = NEW.release_id
)
BEGIN
  SELECT RAISE(ABORT, 'UX event attribution does not match its trace.');
END;

CREATE TRIGGER IF NOT EXISTS reject_conflicting_ux_event
BEFORE UPDATE ON ux_events
WHEN OLD.trace_id IS NOT NEW.trace_id
  OR OLD.release_id IS NOT NEW.release_id
  OR OLD.duration_ms IS NOT NEW.duration_ms
  OR OLD.outcome IS NOT NEW.outcome
  OR OLD.recorded_at_ms IS NOT NEW.recorded_at_ms
BEGIN
  SELECT RAISE(ABORT, 'Interaction identifier conflicts with persisted telemetry.');
END;
