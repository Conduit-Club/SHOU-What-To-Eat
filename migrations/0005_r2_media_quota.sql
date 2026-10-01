-- Application-level guardrails for R2 usage. These limits do not cap the
-- Cloudflare account bill; they only fail closed for this Worker.
CREATE TABLE IF NOT EXISTS media_quota (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  used_bytes INTEGER NOT NULL DEFAULT 0 CHECK (used_bytes >= 0),
  reserved_bytes INTEGER NOT NULL DEFAULT 0 CHECK (reserved_bytes >= 0),
  max_bytes INTEGER NOT NULL DEFAULT 104857600 CHECK (max_bytes > 0)
);
INSERT INTO media_quota (id, used_bytes, reserved_bytes, max_bytes) VALUES (1, 0, 0, 104857600) ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS media_operation_quota (
  month_key TEXT PRIMARY KEY,
  put_count INTEGER NOT NULL DEFAULT 0 CHECK (put_count >= 0),
  max_puts INTEGER NOT NULL DEFAULT 1000 CHECK (max_puts > 0)
);

-- Failed attempts count too. A reservation is retained as orphaned when the
-- R2 or D1 half of an upload fails, so a later cleanup can reconcile it.
CREATE TABLE IF NOT EXISTS media_upload_attempts (
  day_key TEXT PRIMARY KEY,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  max_attempts INTEGER NOT NULL DEFAULT 100 CHECK (max_attempts > 0)
);

CREATE TABLE IF NOT EXISTS media_reservations (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL UNIQUE,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'committed', 'orphan')),
  reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_reservations_state ON media_reservations(state, updated_at);

CREATE TRIGGER IF NOT EXISTS media_reservation_quota_guard
BEFORE INSERT ON media_reservations
WHEN (SELECT used_bytes + reserved_bytes + NEW.byte_size > max_bytes FROM media_quota WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'media_quota_exceeded');
END;

CREATE TRIGGER IF NOT EXISTS media_reservation_quota_after_insert
AFTER INSERT ON media_reservations
BEGIN
  UPDATE media_quota SET reserved_bytes = reserved_bytes + NEW.byte_size WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS media_reservation_quota_after_update
AFTER UPDATE OF state ON media_reservations
WHEN OLD.state = 'reserved' AND NEW.state = 'committed'
BEGIN
  UPDATE media_quota SET reserved_bytes = reserved_bytes - NEW.byte_size WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS media_reservation_quota_retain_orphan
AFTER UPDATE OF state ON media_reservations
WHEN OLD.state = 'committed' AND NEW.state = 'orphan'
BEGIN
  UPDATE media_quota SET reserved_bytes = reserved_bytes + NEW.byte_size WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS media_assets_quota_guard
BEFORE INSERT ON media_assets
WHEN (SELECT used_bytes + NEW.byte_size > max_bytes FROM media_quota WHERE id = 1)
BEGIN
  SELECT RAISE(ABORT, 'media_quota_exceeded');
END;

CREATE TRIGGER IF NOT EXISTS media_assets_quota_after_insert
AFTER INSERT ON media_assets
BEGIN
  UPDATE media_quota SET used_bytes = used_bytes + NEW.byte_size WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS media_assets_quota_after_delete
AFTER DELETE ON media_assets
WHEN OLD.object_state <> 'deleted'
BEGIN
  UPDATE media_quota SET used_bytes = used_bytes - OLD.byte_size WHERE id = 1;
END;

CREATE TRIGGER IF NOT EXISTS media_assets_quota_after_tombstone
AFTER UPDATE OF object_state ON media_assets
WHEN OLD.object_state <> 'deleted' AND NEW.object_state = 'deleted'
BEGIN
  UPDATE media_quota SET used_bytes = used_bytes - OLD.byte_size WHERE id = 1;
END;
