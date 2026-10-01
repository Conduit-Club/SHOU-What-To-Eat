-- Existing databases created with 0001 need the expanded audit action CHECK.
CREATE TABLE audit_events_v2 (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  reviewer TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('submit', 'edit', 'approve', 'reject', 'export', 'retry', 'publish', 'close')),
  version INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO audit_events_v2 (id, submission_id, reviewer, action, version, reason, created_at)
  SELECT id, submission_id, reviewer, action, version, reason, created_at FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_v2 RENAME TO audit_events;
CREATE INDEX IF NOT EXISTS idx_audit_submission_created ON audit_events(submission_id, created_at);
