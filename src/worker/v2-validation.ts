import { tagLabel } from '../utils/catalog-display';
import { isChineseTag } from '../lib/submission-limits';
import { SUBMISSION_LIMITS as LIMITS } from '../lib/submission-limits.js';
export type V2EntityType = 'venue' | 'food' | 'review';
export type V2Review = { rating: number; text: string };
export type V2Coordinates = { latitude: number; longitude: number } | null;
export type V2Submission = {
  schemaVersion: 2;
  entityType: V2EntityType;
  snapshotId: string;
  payload: Record<string, unknown>;
  parentVenueId: string | null;
  parentReceiptToken: string | null;
  expectedImages: number;
  expectedReviewImages: number;
  turnstileToken: string;
  attachedReview: V2Review | null;
  publicJson: Record<string, unknown>;
};

export function validateV2Submission(value: unknown, existingRevision = false): V2Submission {
  if (!isObject(value)) throw new V2ValidationError('invalid_submission');
  allowedKeys(value, ['schemaVersion','entityType','snapshotId','payload','entity','parent','expectedImages','expectedReviewImages','turnstileToken']);
  if (value.schemaVersion !== 2) throw new V2ValidationError('unsupported_schema_version');
  const entityType = value.entityType;
  if (typeof entityType !== 'string' || !['venue', 'food', 'review'].includes(entityType)) throw new V2ValidationError('invalid_entity_type');
  if (value.payload !== undefined && value.entity !== undefined) throw new V2ValidationError('ambiguous_payload');
  const payload = isObject(value.payload) ? value.payload : isObject(value.entity) ? value.entity : null;
  if (!payload) throw new V2ValidationError('invalid_payload');
  const snapshotId = stringValue(value.snapshotId, 1, 160, 'invalid_snapshot_id');
  const expectedImages = boundedInteger(value.expectedImages, 0, entityType === 'review' ? 3 : 6, 'invalid_expected_images');
  const expectedReviewImages = boundedInteger(value.expectedReviewImages ?? 0, 0, 3, 'invalid_expected_review_images');
  if (entityType === 'review' && expectedReviewImages !== 0) throw new V2ValidationError('invalid_expected_review_images');
  const turnstileToken = stringValue(value.turnstileToken, 1, 4096, 'invalid_turnstile_token');
  if (value.parent !== undefined && !isObject(value.parent)) throw new V2ValidationError('invalid_parent_venue');
  const parent = isObject(value.parent) ? value.parent : {};
  allowedKeys(parent, ['venueEntityId','parentReceiptToken']);
  const parentVenueId = optionalString(parent.venueEntityId ?? payload.venueId, 1, 160, 'invalid_parent_venue');
  const parentReceiptToken = optionalString(parent.parentReceiptToken, 1, 4096, 'invalid_parent_receipt');
  if (entityType !== 'food' && Object.keys(parent).length) throw new V2ValidationError('invalid_parent_venue');
  if (parentVenueId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(parentVenueId)) throw new V2ValidationError('invalid_parent_venue');
  if (parent.venueEntityId && payload.venueId && parent.venueEntityId !== payload.venueId) throw new V2ValidationError('parent_venue_mismatch');
  allowedKeys(payload, entityType === 'venue' ? ['name','type','kind','campusScope','category','location','address','campus','floor','landmark','coordinates','distanceM','distance','description','openingHours','tags','averagePrice','attachedReview','sources','visitedAt','verifiedAt','updatedAt','parentId','aliases','foods'] : entityType === 'food' ? ['name','venueId','mealType','mealTypes','description','price','tags','attachedReview','sources','visitedAt','verifiedAt','updatedAt'] : ['targetType','targetId','rating','text','authorAlias','sources','visitedAt','verifiedAt','updatedAt']);
  const attachedReview = entityType === 'venue' || entityType === 'food' ? parseAttachedReview(payload.attachedReview) : null;
  if (!attachedReview && expectedReviewImages > 0) throw new V2ValidationError('review_images_without_review');
  if (entityType === 'review') validateIndependentReview(payload);
  if (entityType === 'venue') validateVenue(payload);
  if (entityType === 'food') validateFood(payload, parentVenueId);
  if (!existingRevision && Array.isArray(payload.tags) && payload.tags.some(tag => !isChineseTag(tag))) throw new V2ValidationError('chinese_tags_required');
  validateSources(payload.sources);
  const publicPayload = cleanStrings(structuredClone(payload)) as Record<string, unknown>;
  delete publicPayload.turnstileToken;
  delete publicPayload.parentReceiptToken;
  delete publicPayload.venueId;
  if (parentVenueId) publicPayload.venueId = parentVenueId;
  if (attachedReview) publicPayload.attachedReview = attachedReview;
  return { schemaVersion: 2, entityType: entityType as V2EntityType, snapshotId, payload: publicPayload, parentVenueId, parentReceiptToken, expectedImages, expectedReviewImages, turnstileToken, attachedReview, publicJson: { schemaVersion: 2, entityType, snapshotId, payload: publicPayload } };
}

/** Validate an auditor's public revision with the submission-only fields
 * supplied from the already stored row. This keeps the same schema checks
 * while never accepting a new Turnstile token or receipt in an admin edit. */
export function validateV2Revision(value: unknown, defaults: { expectedImages: number; expectedReviewImages: number; entityType: V2EntityType; snapshotId: string }): V2Submission {
  if (!isObject(value)) throw new V2ValidationError('invalid_revision');
  const candidate = {
    payload: value.payload,
    ...value,
    schemaVersion: 2,
    entityType: value.entityType ?? defaults.entityType,
    snapshotId: value.snapshotId ?? defaults.snapshotId,
    expectedImages: value.expectedImages ?? defaults.expectedImages,
    expectedReviewImages: value.expectedReviewImages ?? defaults.expectedReviewImages,
    turnstileToken: 'review-only',
  };
  if(isObject(candidate.payload)&&Array.isArray(candidate.payload.tags)){candidate.payload={...candidate.payload,tags:[...new Set(candidate.payload.tags.map((t:unknown)=>typeof t==='string'?tagLabel(t):t))]};if(candidate.payload.tags.some((t:unknown)=>typeof t!=='string'||!isChineseTag(t)))throw new V2ValidationError('chinese_tags_required');}
  const result = validateV2Submission(candidate, true);
  if (result.entityType !== defaults.entityType) throw new V2ValidationError('entity_type_immutable');
  return result;
}

export class V2ValidationError extends Error {
  constructor(public readonly code: string) { super(code); }
}

const MEAL_TYPES = new Set(['breakfast', 'meal', 'snack', 'dessert', 'drink']);
const DISTANCE_BASES = new Set(['reported', 'walking', 'straight-line']);

function validateVenue(value: Record<string, unknown>) {
  stringValue(value.name, 1, LIMITS.name, 'invalid_name');
  const venueType = value.type ?? value.kind;
  stringValue(venueType, 1, 80, 'invalid_venue_type');
  if (!['cafeteria', 'stall', 'restaurant', 'cafe', 'convenience'].includes(String(venueType))) throw new V2ValidationError('invalid_venue_type');
  const scope = value.campusScope ?? value.category;
  if (typeof scope !== 'string' || !['on-campus', 'off-campus'].includes(scope)) throw new V2ValidationError('invalid_campus_scope');
  if (value.kind !== undefined && value.type !== undefined && value.kind !== value.type || value.category !== undefined && value.campusScope !== undefined && value.category !== value.campusScope) throw new V2ValidationError('ambiguous_venue');
  if (value.location !== undefined && !isObject(value.location)) throw new V2ValidationError('invalid_address');
  const location = isObject(value.location) ? value.location : value;
  if (isObject(value.location)) allowedKeys(location, ['address','campusArea','floor','landmark','coordinates','distanceMeters','distanceM','distanceBasis']);
  stringValue(location.address, 1, LIMITS.address, 'invalid_address');
  optionalString(value.description, 0, LIMITS.venueDescription, 'invalid_description');
  optionalString(value.openingHours, 0, 300, 'invalid_opening_hours');
  optionalString(location.campusArea ?? value.campus, 0, 100, 'invalid_campus_area');
  optionalString(location.floor ?? value.floor, 0, 100, 'invalid_floor');
  optionalString(location.landmark ?? value.landmark, 0, 160, 'invalid_landmark');
  validateCoordinates(location.coordinates ?? value.coordinates);
  validateDistance(location, value);
  if ((value.campusScope ?? value.category) === 'on-campus' && [location.distanceMeters, location.distanceM, value.distanceM, value.distance].some(item => item !== null && item !== undefined)) throw new V2ValidationError('on_campus_distance');
  optionalString(value.parentId, 1, 80, 'invalid_parent_venue');
  if (value.parentId && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value.parentId))) throw new V2ValidationError('invalid_parent_venue');
  validateStringArray(value.aliases, 20, 80, 'invalid_aliases');
  validateStringArray(value.foods, 200, 80, 'invalid_foods');
  if (Array.isArray(value.foods) && value.foods.length) throw new V2ValidationError('invalid_foods');
  if (Array.isArray(value.foods) && value.foods.some(id => !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id))) throw new V2ValidationError('invalid_foods');
  validateOptionalTags(value.tags);
  validatePrice(value.averagePrice);
  if (isObject(value.averagePrice) && value.averagePrice.unit !== undefined && value.averagePrice.unit !== '人') throw new V2ValidationError('invalid_price_unit');
  validateDates(value);
}

function validateFood(value: Record<string, unknown>, parentVenueId: string | null) {
  if (!parentVenueId) throw new V2ValidationError('missing_parent_venue');
  stringValue(value.name, 1, LIMITS.name, 'invalid_name');
  const mealType = optionalString(value.mealType, 1, 80, 'invalid_meal_type');
  if (mealType !== null && !MEAL_TYPES.has(mealType)) throw new V2ValidationError('invalid_meal_type');
  if (value.mealTypes !== undefined && (!Array.isArray(value.mealTypes) || value.mealTypes.length > 5 || value.mealTypes.some((item) => typeof item !== 'string' || !MEAL_TYPES.has(item)) || new Set(value.mealTypes).size !== value.mealTypes.length)) throw new V2ValidationError('invalid_meal_type');
  if (mealType && Array.isArray(value.mealTypes) && !value.mealTypes.includes(mealType)) throw new V2ValidationError('invalid_meal_type');
  optionalString(value.description, 0, LIMITS.foodDescription, 'invalid_description');
  validatePrice(value.price);
  validateOptionalTags(value.tags);
  validateDates(value);
}

function validateDistance(location: Record<string, unknown>, value: Record<string, unknown>) {
  const distanceMeters = location.distanceMeters ?? location.distanceM ?? value.distanceM ?? value.distance;
  const distanceBasis = location.distanceBasis;
  const hasDistance = distanceMeters !== undefined && distanceMeters !== null;
  const hasBasis = distanceBasis !== undefined && distanceBasis !== null;
  if (hasDistance !== hasBasis) throw new V2ValidationError('invalid_distance');
  if (!hasDistance) return;
  if (!Number.isSafeInteger(distanceMeters) || Number(distanceMeters) < 0 || Number(distanceMeters) > 100000) throw new V2ValidationError('invalid_distance');
  if (typeof distanceBasis !== 'string' || !DISTANCE_BASES.has(distanceBasis)) throw new V2ValidationError('invalid_distance_basis');
}

function validateIndependentReview(value: Record<string, unknown>) {
  const targetType = value.targetType;
  if (typeof targetType !== 'string' || !['venue', 'food'].includes(targetType)) throw new V2ValidationError('invalid_review_target');
  stringValue(value.targetId, 1, 160, 'invalid_review_target');
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(value.targetId))) throw new V2ValidationError('invalid_review_target');
  optionalString(value.authorAlias, 1, 80, 'invalid_author_alias');
  const rating = boundedInteger(value.rating, 1, 5, 'invalid_rating');
  const text = optionalString(value.text, 0, 256, 'invalid_review_text') ?? '';
  if (!rating && !text) throw new V2ValidationError('empty_review');
  validateDates(value);
}

function parseAttachedReview(value: unknown): V2Review | null {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new V2ValidationError('invalid_attached_review');
  allowedKeys(value, ['rating','text']);
  const rating = boundedInteger(value.rating, 1, 5, 'invalid_rating');
  const text = optionalString(value.text, 0, 256, 'invalid_review_text') ?? '';
  if (!rating && !text) throw new V2ValidationError('empty_review');
  return { rating, text };
}

function validateCoordinates(value: unknown): V2Coordinates {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value) && value.length === 2 && value.every((item) => typeof item === 'number' && Number.isFinite(item))) {
    const [latitude, longitude] = value;
    if (latitude >= -90 && latitude <= 90 && longitude >= -180 && longitude <= 180) return { latitude, longitude };
  }
  throw new V2ValidationError('invalid_coordinates');
}

function validatePrice(value: unknown) {
  if (value === undefined || value === null) return;
  if (typeof value === 'number') throw new V2ValidationError('invalid_price_source');
  if (!isObject(value)) throw new V2ValidationError('invalid_price');
  allowedKeys(value, ['amountCents','minCents','maxCents','currency','unit','source','verifiedAt']);
  const amount = value.amountCents;
  const minimum = value.minCents;
  const maximum = value.maxCents;
  const hasAmount = amount !== undefined && amount !== null;
  const hasRange = minimum !== undefined && minimum !== null || maximum !== undefined && maximum !== null;
  if (hasAmount && hasRange || !hasAmount && (minimum === undefined || minimum === null || maximum === undefined || maximum === null)) throw new V2ValidationError('invalid_price');
  for (const item of [amount, minimum, maximum]) if (item !== undefined && item !== null && (!Number.isInteger(item) || item < 0 || item > 10_000_000)) throw new V2ValidationError('invalid_price');
  if (hasRange && Number(maximum) < Number(minimum)) throw new V2ValidationError('invalid_price');
  if (value.currency !== undefined && value.currency !== 'CNY') throw new V2ValidationError('invalid_price_currency');
  optionalString(value.unit, 1, LIMITS.priceUnit, 'invalid_price_unit');
  stringValue(value.source, 1, LIMITS.priceSource, 'invalid_price_source');
  optionalCalendarDate(value.verifiedAt, 'invalid_price_verified_at');
}

function validateOptionalTags(value: unknown) {
  if (value === undefined || value === null) return;
  validateStringArray(value, LIMITS.tags, LIMITS.tag, 'invalid_tags');
}

function validateSources(value: unknown) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length < 1 || value.length > 30) throw new V2ValidationError('invalid_sources');
  for (const source of value) {
    if (!isObject(source)) throw new V2ValidationError('invalid_sources');
    allowedKeys(source, ['repository','path','revision','license','note','sourceUrl','collectedAt']);
    stringValue(source.repository, 1, 160, 'invalid_sources');
    stringValue(source.path, 1, 300, 'invalid_sources');
    stringValue(source.revision, 1, 160, 'invalid_sources');
    optionalString(source.license, 1, 160, 'invalid_sources');
    optionalString(source.note, 1, 500, 'invalid_sources');
    const sourceUrl = optionalString(source.sourceUrl, 1, 2000, 'invalid_sources');
    if (sourceUrl) { try { const url = new URL(sourceUrl); if (url.protocol !== 'https:' || url.username || url.password) throw new Error(); } catch { throw new V2ValidationError('invalid_sources'); } }
    optionalCalendarDate(source.collectedAt, 'invalid_sources');
  }
}

function validateDates(value: Record<string, unknown>) {
  for (const field of ['visitedAt', 'verifiedAt', 'updatedAt']) optionalCalendarDate(value[field], `invalid_${field}`);
}

function optionalCalendarDate(value: unknown, code: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || !isCalendarDate(value)) throw new V2ValidationError(code);
  return value;
}

export function isCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= daysInMonth[month - 1];
}

function boundedInteger(value: unknown, minimum: number, maximum: number, code: string): number {
  if (!Number.isInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new V2ValidationError(code);
  return Number(value);
}

function stringValue(value: unknown, minimum: number, maximum: number, code: string): string {
  const length = typeof value === 'string' ? (code === 'invalid_review_text' ? Array.from(value).length : value.length) : 0;
  if (typeof value !== 'string' || Array.from(value.trim()).length < minimum || length > maximum || /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(value)) throw new V2ValidationError(code);
  return value.trim();
}

function optionalString(value: unknown, minimum: number, maximum: number, code: string): string | null {
  if (value === undefined || value === null) return null;
  return stringValue(value, minimum, maximum, code);
}

function isObject(value: unknown): value is Record<string, any> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function allowedKeys(value: Record<string, unknown>, keys: string[]) { if (Object.keys(value).some(key => !keys.includes(key))) throw new V2ValidationError('unknown_fields'); }
function validateStringArray(value: unknown, maximum: number, length: number, code: string) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value) || value.length > maximum) throw new V2ValidationError(code);
  const strings = value.map(item => stringValue(item, 1, length, code));
  if (new Set(strings.map(item => item.toLocaleLowerCase())).size !== strings.length) throw new V2ValidationError(code);
}
function cleanStrings(value: unknown): unknown {
  if (typeof value === 'string') return value.trim();
  if (Array.isArray(value)) return value.map(cleanStrings);
  if (isObject(value)) return Object.fromEntries(Object.entries(value).map(([key,item]) => [key,cleanStrings(item)]));
  return value;
}
