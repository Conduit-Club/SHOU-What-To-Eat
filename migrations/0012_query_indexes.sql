-- The cron only needs unpublished legacy work. Completed submissions never
-- enter this covering index; an empty queue reads no historical submission row.
CREATE INDEX idx_submissions_live_resume ON submissions (
  CASE entity_type WHEN 'venue' THEN 0 WHEN 'food' THEN 1 ELSE 2 END,
  created_at, id, version, reviewer, entity_type, live_attempt_at
) WHERE schema_version=2
  AND status IN ('exporting','export_failed','merged_dev','merged_main')
  AND live_published_at IS NULL;

-- Canonical JSON remains the public authority. Scope details with its own
-- relationships rather than scanning the catalog or trusting private drafts.
CREATE INDEX idx_catalog_public_food_venue ON catalog_mirror (
  json_extract(payload_json,'$.venueId'), entity_id
) WHERE entity_type='food'
  AND COALESCE(json_extract(payload_json,'$.status'),'published')='published';

CREATE INDEX idx_catalog_public_review_target ON catalog_mirror (
  json_extract(payload_json,'$.targetType'), json_extract(payload_json,'$.targetId'), entity_id
) WHERE entity_type='review'
  AND COALESCE(json_extract(payload_json,'$.status'),'published')='published';
