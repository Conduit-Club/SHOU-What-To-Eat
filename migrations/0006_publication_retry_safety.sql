-- Publication callback and GitHub delivery state needed for retry-safe
-- processing. Existing callback rows predate jobId and are kept under a
-- deterministic legacy key so a new job with the same content can complete
-- independently.
CREATE TABLE deployment_callbacks_v6 (
  repository TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  job_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('processing', 'completed')),
  attempts INTEGER NOT NULL DEFAULT 1 CHECK (attempts >= 1),
  processed_at TEXT,
  PRIMARY KEY (repository, commit_sha, content_hash, job_id)
);
INSERT INTO deployment_callbacks_v6 (repository, commit_sha, content_hash, job_id, received_at, status, attempts, processed_at)
  SELECT repository, commit_sha, content_hash,
    'legacy:' || commit_sha || ':' || content_hash,
    received_at, 'completed', 1, received_at
  FROM deployment_callbacks;
DROP TABLE deployment_callbacks;
ALTER TABLE deployment_callbacks_v6 RENAME TO deployment_callbacks;

ALTER TABLE webhook_events ADD COLUMN status TEXT NOT NULL DEFAULT 'processed'
  CHECK (status IN ('processing', 'processed', 'failed'));
ALTER TABLE webhook_events ADD COLUMN attempts INTEGER NOT NULL DEFAULT 1
  CHECK (attempts >= 1);
ALTER TABLE webhook_events ADD COLUMN processed_at TEXT;

-- Keep original source/transcoding provenance with the private media row.
ALTER TABLE media_assets ADD COLUMN source_note TEXT;

-- A per-write nonce prevents a losing concurrent reviewer from satisfying a
-- later INSERT ... SELECT with the winner's status/version.
ALTER TABLE submissions ADD COLUMN write_operation_id TEXT;
