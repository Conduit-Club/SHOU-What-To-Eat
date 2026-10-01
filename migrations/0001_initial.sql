CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('new', 'review', 'correction')),
  target_restaurant_id TEXT,
  original_json TEXT NOT NULL,
  revision_json TEXT NOT NULL,
  receipt_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'exporting', 'export_failed', 'merged_dev', 'merged_main', 'deployed')),
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  reviewed_at TEXT,
  reviewer TEXT,
  rejection_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_submissions_status_created ON submissions(status, created_at);
CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  reviewer TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('submit', 'edit', 'approve', 'reject', 'export', 'retry', 'publish', 'close')),
  version INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_submission_created ON audit_events(submission_id, created_at);
CREATE TABLE IF NOT EXISTS publication_jobs (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  submission_version INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'pr_open', 'merged_dev', 'merged_main', 'deployed', 'failed', 'closed')),
  branch TEXT NOT NULL UNIQUE,
  pr_number INTEGER,
  pr_url TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  error_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_publication_status_updated ON publication_jobs(status, updated_at);
CREATE TABLE IF NOT EXISTS rate_limits (
  key_hash TEXT NOT NULL,
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL,
  PRIMARY KEY (key_hash, window_start)
);
CREATE TABLE IF NOT EXISTS webhook_events (
  delivery_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);
