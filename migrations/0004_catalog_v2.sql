-- Version 2 catalog entities and upload state. Legacy submissions remain readable
-- with schema_version=1 and are never promoted by the v2 review handlers.
ALTER TABLE submissions ADD COLUMN schema_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE submissions ADD COLUMN entity_type TEXT;
ALTER TABLE submissions ADD COLUMN entity_id TEXT;
ALTER TABLE submissions ADD COLUMN upload_state TEXT NOT NULL DEFAULT 'none' CHECK (upload_state IN ('none', 'uploading', 'pending', 'failed'));
ALTER TABLE submissions ADD COLUMN expected_images INTEGER NOT NULL DEFAULT 0 CHECK (expected_images BETWEEN 0 AND 6);
ALTER TABLE submissions ADD COLUMN expected_review_images INTEGER NOT NULL DEFAULT 0 CHECK (expected_review_images BETWEEN 0 AND 3);
ALTER TABLE submissions ADD COLUMN snapshot_id TEXT;
ALTER TABLE submissions ADD COLUMN parent_entity_id TEXT;
ALTER TABLE submissions ADD COLUMN parent_receipt_hash TEXT;
ALTER TABLE submissions ADD COLUMN private_json TEXT;
ALTER TABLE submissions ADD COLUMN attached_review_id TEXT;
ALTER TABLE publication_jobs ADD COLUMN main_commit_sha TEXT;

CREATE TABLE IF NOT EXISTS venues (
  id TEXT PRIMARY KEY,
  submission_id TEXT REFERENCES submissions(id),
  parent_id TEXT REFERENCES venues(id),
  type TEXT NOT NULL,
  campus_scope TEXT NOT NULL CHECK (campus_scope IN ('on-campus', 'off-campus')),
  name TEXT NOT NULL,
  address TEXT NOT NULL,
  campus TEXT,
  floor TEXT,
  latitude REAL,
  longitude REAL,
  distance_m REAL,
  average_price INTEGER,
  average_price_min INTEGER,
  average_price_max INTEGER,
  average_price_currency TEXT NOT NULL DEFAULT 'CNY',
  average_price_unit TEXT,
  average_price_source TEXT,
  average_price_verified_at TEXT,
  landmark TEXT,
  distance_basis TEXT CHECK (distance_basis IS NULL OR distance_basis IN ('reported', 'walking', 'straight-line')),
  provenance_json TEXT,
  schema_version INTEGER NOT NULL DEFAULT 2,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('pending', 'published', 'archived')),
  snapshot_id TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_venues_publication ON venues(publication_state, updated_at);
CREATE INDEX IF NOT EXISTS idx_venues_submission ON venues(submission_id);

CREATE TABLE IF NOT EXISTS foods (
  id TEXT PRIMARY KEY,
  submission_id TEXT REFERENCES submissions(id),
  venue_id TEXT NOT NULL REFERENCES venues(id),
  name TEXT NOT NULL,
  meal_type TEXT,
  meal_types_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(meal_types_json)),
  description TEXT,
  price INTEGER,
  price_min INTEGER,
  price_max INTEGER,
  price_currency TEXT NOT NULL DEFAULT 'CNY',
  price_unit TEXT,
  price_source TEXT,
  price_verified_at TEXT,
  provenance_json TEXT,
  schema_version INTEGER NOT NULL DEFAULT 2,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('pending', 'published', 'archived')),
  snapshot_id TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_foods_venue_publication ON foods(venue_id, publication_state);
CREATE INDEX IF NOT EXISTS idx_foods_submission ON foods(submission_id);

CREATE TABLE IF NOT EXISTS food_meal_types (
  food_id TEXT NOT NULL REFERENCES foods(id),
  meal_type TEXT NOT NULL CHECK (meal_type IN ('breakfast', 'meal', 'snack', 'dessert', 'drink')),
  ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
  PRIMARY KEY (food_id, meal_type)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_food_meal_type_ordinal ON food_meal_types(food_id, ordinal);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  submission_id TEXT REFERENCES submissions(id),
  target_type TEXT NOT NULL CHECK (target_type IN ('venue', 'food')),
  target_id TEXT NOT NULL,
  rating INTEGER CHECK (rating IS NULL OR rating BETWEEN 1 AND 5),
  text TEXT NOT NULL DEFAULT '' CHECK (length(text) <= 256),
  schema_version INTEGER NOT NULL DEFAULT 2,
  publication_state TEXT NOT NULL CHECK (publication_state IN ('pending', 'published', 'archived')),
  snapshot_id TEXT,
  content_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  published_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_reviews_target_publication ON reviews(target_type, target_id, publication_state);
CREATE INDEX IF NOT EXISTS idx_reviews_submission ON reviews(submission_id);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  tag_key TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS entity_tags (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('venue', 'food', 'review')),
  entity_id TEXT NOT NULL,
  tag_id TEXT NOT NULL REFERENCES tags(id),
  PRIMARY KEY (entity_type, entity_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tag_id);

CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('venue', 'food', 'review')),
  entity_id TEXT NOT NULL,
  slot TEXT NOT NULL CHECK (slot IN ('entity', 'attachedReview')),
  slot_index INTEGER NOT NULL CHECK (slot_index BETWEEN 0 AND 5),
  object_key TEXT NOT NULL UNIQUE,
  content_type TEXT NOT NULL CHECK (content_type = 'image/webp'),
  byte_size INTEGER NOT NULL CHECK (byte_size BETWEEN 1 AND 2097152),
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  alt TEXT NOT NULL,
  source TEXT NOT NULL,
  copyright_holder TEXT NOT NULL,
  license TEXT NOT NULL,
  permission TEXT NOT NULL DEFAULT 'pending' CHECK (permission IN ('pending', 'approved')),
  rights_confirmed INTEGER NOT NULL CHECK (rights_confirmed IN (0, 1)),
  is_illustrative INTEGER NOT NULL CHECK (is_illustrative IN (0, 1)),
  object_state TEXT NOT NULL CHECK (object_state IN ('private', 'published', 'deleted')),
  schema_version INTEGER NOT NULL DEFAULT 2,
  created_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata_json TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (submission_id, slot, slot_index)
);
CREATE INDEX IF NOT EXISTS idx_media_assets_submission ON media_assets(submission_id, slot, slot_index);
CREATE INDEX IF NOT EXISTS idx_media_assets_entity ON media_assets(entity_type, entity_id, object_state);

CREATE TABLE IF NOT EXISTS catalog_snapshots (
  id TEXT PRIMARY KEY,
  content_hash TEXT NOT NULL UNIQUE,
  source_revision TEXT,
  generated_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'published', 'superseded'))
);
CREATE TABLE IF NOT EXISTS catalog_mirror (
  entity_type TEXT NOT NULL CHECK (entity_type IN ('venue', 'food', 'review')),
  entity_id TEXT NOT NULL,
  snapshot_id TEXT NOT NULL REFERENCES catalog_snapshots(id),
  payload_json TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS idx_catalog_mirror_snapshot ON catalog_mirror(snapshot_id);

CREATE TABLE IF NOT EXISTS deployment_callbacks (
  repository TEXT NOT NULL,
  commit_sha TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (repository, commit_sha, content_hash)
);

-- 0001/0003 databases already have audit_events with a narrower CHECK list.
-- Rebuild it once so new upload/finalize/mirror/callback actions remain auditable.
CREATE TABLE audit_events_v4 (
  id TEXT PRIMARY KEY,
  submission_id TEXT NOT NULL REFERENCES submissions(id),
  reviewer TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('submit', 'image_upload', 'image_finalize', 'upload_failed', 'edit', 'approve', 'reject', 'export', 'retry', 'publish', 'close', 'deploy_callback', 'mirror')),
  version INTEGER NOT NULL,
  reason TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO audit_events_v4 (id, submission_id, reviewer, action, version, reason, created_at)
  SELECT id, submission_id, reviewer, action, version, reason, created_at FROM audit_events;
DROP TABLE audit_events;
ALTER TABLE audit_events_v4 RENAME TO audit_events;
CREATE INDEX IF NOT EXISTS idx_audit_submission_created ON audit_events(submission_id, created_at);
