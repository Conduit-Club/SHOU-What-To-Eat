// Use Astro's schema entrypoint so content loaders and the Worker share the
// same Zod version and validation rules.
import { z } from 'astro/zod';
import { publicAvatar } from '../../utils/review-identity.js';

export const CATALOG_SCHEMA_VERSION = 2 as const;

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
const requiredText = (max: number) => z.string().min(1).max(max).refine((value) => value.trim().length > 0, '文本不能为空');
const optionalText = (max: number) => z.string().max(max).nullable().default(null);
const dateValue = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期必须为 YYYY-MM-DD').refine((value) => {
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}, '日期不是有效的日历日期');
const optionalDate = dateValue.nullable().default(null);
const httpsUrl = z.string().url().refine((value) => new URL(value).protocol === 'https:', 'URL 必须使用 HTTPS');
const boundedTags = z.array(requiredText(60)).max(30).refine((values) => new Set(values).size === values.length, '标签不能重复').default([]);

export const imageSchema = z.object({
  url: httpsUrl,
  alt: requiredText(200),
  sourceUrl: httpsUrl.nullable().default(null),
  sourceNote: optionalText(500),
  author: optionalText(160),
  license: optionalText(160),
  permission: z.enum(['approved', 'pending']),
  isIllustrative: z.boolean().default(false),
  coverEligible: z.boolean().optional(),
  hidden: z.boolean().optional(),
  width: z.number().int().positive().max(4096).nullable().default(null),
  height: z.number().int().positive().max(4096).nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.width === null) !== (value.height === null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['width'], message: '图片宽高必须同时提供' });
  if (value.permission === 'approved') {
    if (value.sourceUrl === null) context.addIssue({ code: z.ZodIssueCode.custom, path: ['sourceUrl'], message: '已批准图片必须保留 HTTPS 来源页' });
    if (value.license === null || value.license.trim().length === 0) context.addIssue({ code: z.ZodIssueCode.custom, path: ['license'], message: '已批准图片必须保留许可信息' });
  }
});

export const sourceSchema = z.object({
  repository: requiredText(160),
  path: requiredText(300),
  revision: requiredText(160),
  license: optionalText(160),
  note: optionalText(500),
  sourceUrl: httpsUrl.nullable().default(null),
  collectedAt: optionalDate,
}).strict();

const coordinates = z.tuple([
  z.number().finite().min(-90).max(90),
  z.number().finite().min(-180).max(180),
]);

export const locationSchema = z.object({
  address: requiredText(300),
  campusArea: optionalText(100),
  floor: optionalText(100),
  landmark: optionalText(160),
  coordinates: coordinates.nullable().default(null),
  distanceMeters: z.number().int().nonnegative().nullable().default(null),
  distanceBasis: z.enum(['reported', 'walking', 'straight-line']).nullable().default(null),
}).strict().superRefine((value, context) => {
  if ((value.distanceMeters === null) !== (value.distanceBasis === null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['distanceBasis'], message: '距离数值和依据必须同时提供或同时为空' });
  }
});

const priceRange = z.object({
  minCents: z.number().int().nonnegative(),
  maxCents: z.number().int().nonnegative(),
  currency: z.literal('CNY'),
  unit: z.literal('人'),
  source: requiredText(300),
  verifiedAt: optionalDate,
}).strict().refine((value) => value.maxCents >= value.minCents, { path: ['maxCents'], message: '最高价不能低于最低价' });

const foodPrice = z.object({
  amountCents: z.number().int().nonnegative().nullable().default(null),
  minCents: z.number().int().nonnegative().nullable().default(null),
  maxCents: z.number().int().nonnegative().nullable().default(null),
  currency: z.literal('CNY'),
  unit: requiredText(20),
  source: requiredText(300),
  verifiedAt: optionalDate,
}).strict().superRefine((value, context) => {
  const hasAmount = value.amountCents !== null;
  const hasRange = value.minCents !== null || value.maxCents !== null;
  if (hasAmount && hasRange) context.addIssue({ code: z.ZodIssueCode.custom, path: ['amountCents'], message: '单价和区间不能同时提供' });
  if (!hasAmount && (value.minCents === null || value.maxCents === null)) context.addIssue({ code: z.ZodIssueCode.custom, path: ['minCents'], message: '价格必须提供单价或完整区间' });
  if (value.minCents !== null && value.maxCents !== null && value.maxCents < value.minCents) context.addIssue({ code: z.ZodIssueCode.custom, path: ['maxCents'], message: '最高价不能低于最低价' });
});

export const datesSchema = z.object({
  addedAt: optionalDate,
  visitedAt: optionalDate,
  verifiedAt: optionalDate,
  updatedAt: optionalDate,
}).strict();

export const coverSchema = z.object({
  url: httpsUrl,
  reviewId: slug.nullable().default(null),
  x: z.number().finite().min(0).max(100).default(50),
  y: z.number().finite().min(0).max(100).default(50),
}).strict();

export const venueSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  id: slug,
  name: requiredText(120),
  kind: z.enum(['cafeteria', 'stall', 'restaurant', 'cafe', 'convenience']),
  parentId: slug.nullable().default(null),
  category: z.enum(['on-campus', 'off-campus']),
  aliases: z.array(requiredText(80)).max(20).default([]),
  tags: boundedTags,
  location: locationSchema,
  averagePrice: priceRange.nullable().default(null),
  description: optionalText(2000),
  openingHours: optionalText(300),
  foods: z.array(slug).max(200).default([]),
  images: z.array(imageSchema).max(30).default([]),
  status: z.enum(['published','archived']).optional(),
  cover: coverSchema.nullable().optional(),
  sources: z.array(sourceSchema).min(1).max(30),
  dates: datesSchema,
}).strict();

export const foodSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  id: slug,
  name: requiredText(120),
  venueId: slug,
  mealTypes: z.array(z.enum(['breakfast', 'meal', 'snack', 'dessert', 'drink'])).max(5).refine((values) => new Set(values).size === values.length, '餐段不能重复').default([]),
  price: foodPrice.nullable().default(null),
  tags: boundedTags,
  description: optionalText(1000),
  images: z.array(imageSchema).max(30).default([]),
  status: z.enum(['published','archived']).optional(),
  cover: coverSchema.nullable().optional(),
  sources: z.array(sourceSchema).min(1).max(30),
  dates: datesSchema,
}).strict();

const reviewText = z.string().refine((value) => [...value].length <= 256, '评价不能超过 256 个 Unicode code point');

export const reviewSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  id: slug,
  targetType: z.enum(['venue', 'food']),
  targetId: slug,
  rating: z.number().int().min(1).max(5).nullable().default(null),
  text: reviewText,
  images: z.array(imageSchema).max(10).default([]),
  status: z.enum(['published','archived']).optional(),
  authorAlias: optionalText(80),
  authorAvatar: z.string().max(2000).refine(value => publicAvatar(value) === value, '头像必须来自 Auth 固定头像路径').nullable().optional(),
  visitedAt: optionalDate,
  verifiedAt: optionalDate,
  updatedAt: optionalDate,
  sources: z.array(sourceSchema).min(1).max(30),
}).strict().superRefine((value, context) => {
  if (value.authorAvatar && !value.authorAlias?.trim()) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['authorAvatar'], message: '匿名评价不能包含头像' });
  }
  if (value.rating === null && value.text.trim().length === 0 && value.images.length === 0) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['text'], message: '无星级评价必须有文字或图片' });
  }
});

export const catalogSchema = z.object({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  restaurants: z.array(venueSchema),
  foods: z.array(foodSchema),
  reviews: z.array(reviewSchema),
}).strict();

export type Image = z.infer<typeof imageSchema>;
export type Source = z.infer<typeof sourceSchema>;
export type Location = z.infer<typeof locationSchema>;
export type Venue = z.infer<typeof venueSchema>;
export type Food = z.infer<typeof foodSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Catalog = z.infer<typeof catalogSchema>;

export const DISTANCE_TAGS = [
  { meters: 500, tag: 'within-500m' },
  { meters: 1_000, tag: 'within-1km' },
  { meters: 2_000, tag: 'within-2km' },
] as const;

export function deriveDistanceTags(venue: Pick<Venue, 'category' | 'tags' | 'location'>): string[] {
  const tags = new Set(venue.tags);
  for (const threshold of DISTANCE_TAGS) { tags.delete(threshold.tag); tags.delete(threshold.meters===500?'校外500米内':`校外${threshold.meters/1000}公里内`); }
  const { distanceMeters, distanceBasis } = venue.location;
  if (venue.category === 'off-campus' && distanceMeters !== null && distanceBasis !== null) {
    for (const threshold of DISTANCE_TAGS) if (distanceMeters <= threshold.meters) tags.add(threshold.tag);
  }
  return [...tags];
}

export function validateCatalog(input: unknown): Catalog {
  const catalog = catalogSchema.parse(input);
  const venues = new Map<string, Venue>();
  const foods = new Map<string, Food>();
  const reviews = new Map<string, Review>();
  for (const venue of catalog.restaurants) {
    if (venues.has(venue.id)) throw new Error(`duplicate venue id: ${venue.id}`);
    venues.set(venue.id, venue);
  }
  for (const food of catalog.foods) {
    if (foods.has(food.id)) throw new Error(`duplicate food id: ${food.id}`);
    if (!venues.has(food.venueId)) throw new Error(`food ${food.id} references missing venue ${food.venueId}`);
    foods.set(food.id, food);
  }
  const foodOwners = new Map<string, string>();
  for (const venue of catalog.restaurants) {
    for (const foodId of venue.foods) {
      const owner = foodOwners.get(foodId);
      if (owner && owner !== venue.id) throw new Error(`food ${foodId} is listed by both ${owner} and ${venue.id}`);
      foodOwners.set(foodId, venue.id);
    }
  }
  for (const food of catalog.foods) {
    if (foodOwners.get(food.id) !== food.venueId) throw new Error(`food ${food.id} is not listed by its venue ${food.venueId}`);
  }
  for (const venue of catalog.restaurants) {
    if (venue.category === 'on-campus' && (venue.location.distanceMeters !== null || venue.location.distanceBasis !== null)) {
      throw new Error(`on-campus venue ${venue.id} cannot have an off-campus distance`);
    }
  }
  for (const review of catalog.reviews) {
    if (reviews.has(review.id)) throw new Error(`duplicate review id: ${review.id}`);
    if (review.targetType === 'venue' && !venues.has(review.targetId)) throw new Error(`review ${review.id} references missing venue ${review.targetId}`);
    if (review.targetType === 'food' && !foods.has(review.targetId)) throw new Error(`review ${review.id} references missing food ${review.targetId}`);
    reviews.set(review.id, review);
  }
  for (const venue of catalog.restaurants) {
    if (venue.parentId !== null && !venues.has(venue.parentId)) throw new Error(`venue ${venue.id} references missing parent ${venue.parentId}`);
    if (venue.parentId === venue.id) throw new Error(`venue ${venue.id} cannot parent itself`);
    for (const foodId of venue.foods) {
      const food = foods.get(foodId);
      if (!food) throw new Error(`venue ${venue.id} references missing food ${foodId}`);
      if (food.venueId !== venue.id) throw new Error(`food ${foodId} belongs to ${food.venueId}, not ${venue.id}`);
    }
  }
  for (const venue of catalog.restaurants) {
    const seen = new Set<string>();
    let current: Venue | undefined = venue;
    while (current && current.parentId !== null) {
      if (seen.has(current.id)) throw new Error(`venue parent cycle at ${current.id}`);
      seen.add(current.id);
      current = current.parentId ? venues.get(current.parentId) : undefined;
    }
  }
  return catalog;
}

export function loadCatalog(input: { restaurants: unknown[]; foods: unknown[]; reviews: unknown[] }): Catalog {
  return validateCatalog({ schemaVersion: CATALOG_SCHEMA_VERSION, ...input });
}

export function generateCatalogSnapshot(input: Catalog | { restaurants: unknown[]; foods: unknown[]; reviews: unknown[] }) {
  const catalog = 'schemaVersion' in input ? validateCatalog(input) : loadCatalog(input);
  const publicImages = <T extends { images: Image[] }>(record: T): T => ({
    ...record,
    images: record.images.filter((image) => image.permission === 'approved'),
  });
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    restaurants: [...catalog.restaurants].sort((a, b) => a.id.localeCompare(b.id)).map((venue) => publicImages({ ...venue, tags: deriveDistanceTags(venue) })),
    foods: [...catalog.foods].sort((a, b) => a.id.localeCompare(b.id)).map(publicImages),
    reviews: [...catalog.reviews].sort((a, b) => a.id.localeCompare(b.id)).map(publicImages).filter((review) => review.rating !== null || review.text.trim().length > 0 || review.images.length > 0),
  } satisfies Catalog;
}

function sqlString(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function generateSeedSql(input: Catalog | { restaurants: unknown[]; foods: unknown[]; reviews: unknown[] }) {
  const snapshot = generateCatalogSnapshot(input);
  const snapshotHash = await sha256Hex(JSON.stringify(snapshot));
  const snapshotId = `catalog-v${CATALOG_SCHEMA_VERSION}-${snapshotHash.slice(0, 16)}`;
  const entities = [
    ...snapshot.restaurants.map((payload) => ({ entityType: 'venue', payload })),
    ...snapshot.foods.map((payload) => ({ entityType: 'food', payload })),
    ...snapshot.reviews.map((payload) => ({ entityType: 'review', payload })),
  ];
  const lines = [
    '-- Generated by scripts/prepare-catalog.mjs. Do not edit.',
    'BEGIN;',
    '-- Requires migrations/0004_catalog_v2.sql (catalog_snapshots/catalog_mirror).',
    `INSERT INTO catalog_snapshots (id, content_hash, source_revision, generated_at, status) VALUES (${sqlString(snapshotId)}, ${sqlString(snapshotHash)}, 'working-tree', CURRENT_TIMESTAMP, 'published') ON CONFLICT(id) DO UPDATE SET content_hash = excluded.content_hash, source_revision = excluded.source_revision, generated_at = excluded.generated_at, status = excluded.status;`,
    'DELETE FROM catalog_mirror;',
  ];
  for (const { entityType, payload } of entities) {
    const entityHash = await sha256Hex(JSON.stringify(payload));
    lines.push(`INSERT INTO catalog_mirror (entity_type, entity_id, snapshot_id, payload_json, content_hash, synced_at) VALUES (${sqlString(entityType)}, ${sqlString(payload.id)}, ${sqlString(snapshotId)}, ${sqlString(JSON.stringify(payload))}, ${sqlString(entityHash)}, CURRENT_TIMESTAMP);`);
  }
  lines.push('COMMIT;', '');
  return lines.join('\n');
}
