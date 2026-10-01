-- catalog_mirror becomes the authoritative published catalog. No repository
-- seed is applied after this migration; existing pending submissions stay private.
CREATE TABLE live_catalog_state (
  id INTEGER PRIMARY KEY CHECK(id = 1),
  revision INTEGER NOT NULL DEFAULT 1,
  backed_revision INTEGER NOT NULL DEFAULT 0,
  backup_commit TEXT,
  backed_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO live_catalog_state(id) VALUES(1);
CREATE TABLE catalog_history (
  revision INTEGER NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY(revision, entity_type, entity_id)
);
INSERT INTO catalog_history SELECT 1,entity_type,entity_id,payload_json,synced_at FROM catalog_mirror;
-- A failing assertion aborts the entire D1 batch, including preceding writes.
CREATE TABLE live_write_assertion (ok INTEGER NOT NULL CHECK(ok = 1));
ALTER TABLE submissions ADD COLUMN live_published_at TEXT;
ALTER TABLE submissions ADD COLUMN live_error TEXT;
ALTER TABLE submissions ADD COLUMN live_attempt_at TEXT;
CREATE TABLE backup_exports (
  revision INTEGER PRIMARY KEY,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);
