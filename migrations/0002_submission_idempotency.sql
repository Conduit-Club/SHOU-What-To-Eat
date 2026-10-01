CREATE TABLE IF NOT EXISTS submission_idempotency (
  key_hash TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  request_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_submission_idempotency_submission ON submission_idempotency(submission_id);
