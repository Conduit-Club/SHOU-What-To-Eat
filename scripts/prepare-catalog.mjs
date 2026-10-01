import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateCatalogSnapshot, generateSeedSql, loadCatalog } from '../src/lib/catalog/index.ts';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = dirname(scriptDir);

async function readCollection(name) {
  const directory = join(projectRoot, 'src', 'content', name);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(join(directory, file), 'utf8'))));
}

const catalog = loadCatalog({
  restaurants: await readCollection('restaurants'),
  foods: await readCollection('foods'),
  reviews: await readCollection('reviews'),
});
const snapshot = generateCatalogSnapshot(catalog);
const generatedDirectory = join(projectRoot, '.generated');
await mkdir(generatedDirectory, { recursive: true });
await writeFile(join(generatedDirectory, 'catalog.json'), `${JSON.stringify(snapshot, null, 2)}\n`, 'utf8');
const mirrorSeedSql = (await generateSeedSql(snapshot))
  .replace(/^BEGIN;\s*/m, '')
  .replace(/\s*COMMIT;\s*$/m, '\n');
const snapshotId = mirrorSeedSql.match(/catalog-v2-[a-f0-9]{16,64}/i)?.[0] ?? null;
if (!snapshotId) throw new Error('无法从生成的目录种子中取得 snapshotId。');
const seedSql = await appendPublishedEntitySeed(mirrorSeedSql, snapshot, snapshotId);
await writeFile(join(generatedDirectory, 'seed.sql'), seedSql, 'utf8');
await writeFile(join(generatedDirectory, 'catalog-snapshot-id.txt'), `${snapshotId}\n`, 'utf8');
await mkdir(join(projectRoot, 'public'), { recursive: true });
await writeFile(join(projectRoot, 'public', 'catalog-snapshot.json'), `${JSON.stringify({ schemaVersion: 2, snapshotId }, null, 2)}\n`, 'utf8');
console.log(`Generated ${snapshot.restaurants.length} venues, ${snapshot.foods.length} foods and ${snapshot.reviews.length} reviews.`);

async function appendPublishedEntitySeed(seedSql, catalogSnapshot, catalogSnapshotId) {
  const lines = ['-- Published normalized catalog rows; pending submissions are never overwritten.'];
  const venueIds = catalogSnapshot.restaurants.map((venue) => venue.id);
  const foodIds = catalogSnapshot.foods.map((food) => food.id);
  const reviewIds = catalogSnapshot.reviews.map((review) => review.id);

  for (const venue of catalogSnapshot.restaurants) {
    const location = venue.location;
    const price = venue.averagePrice;
    const contentHash = await hashJson(venue);
    lines.push(`INSERT INTO venues (id, submission_id, parent_id, type, campus_scope, name, address, campus, floor, latitude, longitude, distance_m, average_price, average_price_min, average_price_max, average_price_currency, average_price_unit, average_price_source, average_price_verified_at, landmark, distance_basis, provenance_json, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at, published_at) VALUES (${sql(venue.id)}, NULL, NULL, ${sql(venue.kind)}, ${sql(venue.category)}, ${sql(venue.name)}, ${sql(location.address)}, ${sql(location.campusArea)}, ${sql(location.floor)}, ${sql(location.coordinates?.[0] ?? null)}, ${sql(location.coordinates?.[1] ?? null)}, ${sql(location.distanceMeters)}, ${sql(price && price.minCents === price.maxCents ? price.minCents : null)}, ${sql(price?.minCents ?? null)}, ${sql(price?.maxCents ?? null)}, ${sql(price?.currency ?? 'CNY')}, ${sql(price?.unit ?? '人')}, ${sql(price?.source ?? null)}, ${sql(price?.verifiedAt ?? null)}, ${sql(location.landmark)}, ${sql(location.distanceBasis)}, ${sql(JSON.stringify({ sources: venue.sources }))}, 2, 'published', ${sql(catalogSnapshotId)}, ${sql(contentHash)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET type = excluded.type, campus_scope = excluded.campus_scope, name = excluded.name, address = excluded.address, campus = excluded.campus, floor = excluded.floor, latitude = excluded.latitude, longitude = excluded.longitude, distance_m = excluded.distance_m, average_price = excluded.average_price, average_price_min = excluded.average_price_min, average_price_max = excluded.average_price_max, average_price_currency = excluded.average_price_currency, average_price_unit = excluded.average_price_unit, average_price_source = excluded.average_price_source, average_price_verified_at = excluded.average_price_verified_at, landmark = excluded.landmark, distance_basis = excluded.distance_basis, provenance_json = excluded.provenance_json, schema_version = excluded.schema_version, publication_state = 'published', snapshot_id = excluded.snapshot_id, content_hash = excluded.content_hash, updated_at = CURRENT_TIMESTAMP, published_at = COALESCE(venues.published_at, CURRENT_TIMESTAMP) WHERE venues.publication_state = 'published';`);
  }
  for (const venue of catalogSnapshot.restaurants) {
    if (venue.parentId) lines.push(`UPDATE venues SET parent_id = ${sql(venue.parentId)} WHERE id = ${sql(venue.id)} AND publication_state = 'published' AND submission_id IS NULL;`);
  }
  for (const food of catalogSnapshot.foods) {
    const price = food.price;
    const contentHash = await hashJson(food);
    lines.push(`INSERT INTO foods (id, submission_id, venue_id, name, meal_type, meal_types_json, description, price, price_min, price_max, price_currency, price_unit, price_source, price_verified_at, provenance_json, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at, published_at) VALUES (${sql(food.id)}, NULL, ${sql(food.venueId)}, ${sql(food.name)}, ${sql(food.mealTypes[0] ?? null)}, ${sql(JSON.stringify(food.mealTypes))}, ${sql(food.description)}, ${sql(price?.amountCents ?? null)}, ${sql(price?.minCents ?? null)}, ${sql(price?.maxCents ?? null)}, ${sql(price?.currency ?? 'CNY')}, ${sql(price?.unit ?? null)}, ${sql(price?.source ?? null)}, ${sql(price?.verifiedAt ?? null)}, ${sql(JSON.stringify({ sources: food.sources }))}, 2, 'published', ${sql(catalogSnapshotId)}, ${sql(contentHash)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET venue_id = excluded.venue_id, name = excluded.name, meal_type = excluded.meal_type, meal_types_json = excluded.meal_types_json, description = excluded.description, price = excluded.price, price_min = excluded.price_min, price_max = excluded.price_max, price_currency = excluded.price_currency, price_unit = excluded.price_unit, price_source = excluded.price_source, price_verified_at = excluded.price_verified_at, provenance_json = excluded.provenance_json, schema_version = excluded.schema_version, publication_state = 'published', snapshot_id = excluded.snapshot_id, content_hash = excluded.content_hash, updated_at = CURRENT_TIMESTAMP, published_at = COALESCE(foods.published_at, CURRENT_TIMESTAMP) WHERE foods.publication_state = 'published';`);
    lines.push(`DELETE FROM food_meal_types WHERE food_id = ${sql(food.id)} AND EXISTS (SELECT 1 FROM foods WHERE id = ${sql(food.id)} AND publication_state = 'published' AND submission_id IS NULL);`);
    food.mealTypes.forEach((mealType, ordinal) => lines.push(`INSERT INTO food_meal_types (food_id, meal_type, ordinal) SELECT ${sql(food.id)}, ${sql(mealType)}, ${sql(ordinal)} WHERE EXISTS (SELECT 1 FROM foods WHERE id = ${sql(food.id)} AND publication_state = 'published') ON CONFLICT(food_id, meal_type) DO UPDATE SET ordinal = excluded.ordinal;`));
  }
  for (const review of catalogSnapshot.reviews) {
    const contentHash = await hashJson(review);
    lines.push(`INSERT INTO reviews (id, submission_id, target_type, target_id, rating, text, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at, published_at) VALUES (${sql(review.id)}, NULL, ${sql(review.targetType)}, ${sql(review.targetId)}, ${sql(review.rating)}, ${sql(review.text)}, 2, 'published', ${sql(catalogSnapshotId)}, ${sql(contentHash)}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET target_type = excluded.target_type, target_id = excluded.target_id, rating = excluded.rating, text = excluded.text, schema_version = excluded.schema_version, publication_state = 'published', snapshot_id = excluded.snapshot_id, content_hash = excluded.content_hash, updated_at = CURRENT_TIMESTAMP, published_at = COALESCE(reviews.published_at, CURRENT_TIMESTAMP) WHERE reviews.publication_state = 'published';`);
  }
  lines.push(`UPDATE venues SET publication_state = 'archived', updated_at = CURRENT_TIMESTAMP WHERE submission_id IS NULL AND publication_state = 'published' AND id NOT IN (${venueIds.map(sql).join(', ')});`);
  lines.push(`UPDATE foods SET publication_state = 'archived', updated_at = CURRENT_TIMESTAMP WHERE submission_id IS NULL AND publication_state = 'published' AND id NOT IN (${foodIds.map(sql).join(', ')});`);
  lines.push(`UPDATE reviews SET publication_state = 'archived', updated_at = CURRENT_TIMESTAMP WHERE submission_id IS NULL AND publication_state = 'published' AND id NOT IN (${reviewIds.map(sql).join(', ')});`);
  return `${seedSql.trimEnd()}\n${lines.join('\n')}\n`;
}

async function hashJson(value) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(value)));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function sql(value) {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replaceAll("'", "''")}'`;
}
