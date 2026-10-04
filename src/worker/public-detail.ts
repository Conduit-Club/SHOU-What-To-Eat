import type { Catalog, Food, Review, Venue } from '../lib/catalog/index.js';
import { parseManaged, type ManagedType } from '../lib/catalog/management.js';
import { publicCatalog } from '../lib/catalog/visibility.js';
import type { LiveState } from './live-catalog.js';

/** Keep the same visibility and cover resolution as the complete public catalog.
 * One read-only D1 batch sees a consistent revision, target and related records.
 * INDEXED BY requires migration 0012; unary + removes the TEXT column affinity
 * on the scalar venue ID so SQLite can seek the JSON expression index. */
export const PUBLIC_DETAIL_SQL = `
WITH target AS MATERIALIZED (
  SELECT entity_type,entity_id,payload_json FROM catalog_mirror
  WHERE entity_type=? AND entity_id=?
    AND COALESCE(json_extract(payload_json,'$.status'),'published')='published'
), owner_venue AS MATERIALIZED (
  SELECT entity_type,entity_id,payload_json FROM catalog_mirror
  WHERE entity_type='venue' AND entity_id=(
    SELECT CASE entity_type WHEN 'food' THEN json_extract(payload_json,'$.venueId') ELSE entity_id END FROM target
  ) AND COALESCE(json_extract(payload_json,'$.status'),'published')='published'
), venue_foods AS MATERIALIZED (
  SELECT entity_type,entity_id,payload_json FROM catalog_mirror INDEXED BY idx_catalog_public_food_venue
  WHERE entity_type='food' AND json_extract(payload_json,'$.venueId')=(SELECT +entity_id FROM owner_venue)
    AND COALESCE(json_extract(payload_json,'$.status'),'published')='published'
), target_reviews AS (
  SELECT entity_type,entity_id,payload_json FROM catalog_mirror INDEXED BY idx_catalog_public_review_target
  WHERE entity_type='review' AND json_extract(payload_json,'$.targetType')=? AND json_extract(payload_json,'$.targetId')=?
    AND COALESCE(json_extract(payload_json,'$.status'),'published')='published'
    AND EXISTS(SELECT 1 FROM owner_venue)
), cover_ids AS (
  SELECT json_extract(payload_json,'$.cover.reviewId') AS id FROM target
  UNION SELECT json_extract(payload_json,'$.cover.reviewId') FROM owner_venue
  UNION SELECT json_extract(payload_json,'$.cover.reviewId') FROM venue_foods
)
SELECT entity_type,entity_id,payload_json FROM target
UNION SELECT entity_type,entity_id,payload_json FROM owner_venue
UNION SELECT entity_type,entity_id,payload_json FROM venue_foods
UNION SELECT entity_type,entity_id,payload_json FROM target_reviews
UNION SELECT entity_type,entity_id,payload_json FROM catalog_mirror
  WHERE entity_type='review' AND entity_id IN (SELECT id FROM cover_ids WHERE id IS NOT NULL)
    AND COALESCE(json_extract(payload_json,'$.status'),'published')='published'
ORDER BY entity_type,entity_id`;

export async function readPublicDetail(db: D1Database, type: 'food' | 'venue', id: string) {
  const result = await db.batch([
    db.prepare('SELECT revision,updated_at FROM live_catalog_state WHERE id=1'),
    db.prepare(PUBLIC_DETAIL_SQL).bind(type,id,type,id),
  ]);
  const state = result[0].results[0] as unknown as Pick<LiveState, 'revision' | 'updated_at'>;
  if (!state) throw new Error('catalog_unavailable');
  const records = result[1].results.map((row: any) => ({ type: row.entity_type as ManagedType, record: parseManaged(row.entity_type, JSON.parse(row.payload_json)) }));
  const catalog: Catalog = {
    schemaVersion: 2,
    restaurants: records.filter(row => row.type === 'venue').map(row => row.record as Venue),
    foods: records.filter(row => row.type === 'food').map(row => row.record as Food),
    reviews: records.filter(row => row.type === 'review').map(row => row.record as Review),
  };
  const visible = publicCatalog(catalog);
  const record = (type === 'food' ? visible.foods : visible.restaurants).find(row => row.id === id);
  return { state, record,
    reviews: visible.reviews.filter(review => review.targetType === type && review.targetId === id),
    venue: type === 'food' && record ? visible.restaurants.find(venue => venue.id === (record as Food).venueId) ?? null : null,
    foods: type === 'venue' ? visible.foods.filter(food => food.venueId === id) : [],
  };
}
