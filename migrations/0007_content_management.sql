-- Only one in-flight catalog change per entity. Failed/closed changes must
-- be explicitly cancelled before a newer edit can replace their base revision.
CREATE UNIQUE INDEX IF NOT EXISTS idx_active_catalog_edit ON submissions(entity_id)
WHERE entity_type = 'management' AND status NOT IN ('deployed', 'rejected');
