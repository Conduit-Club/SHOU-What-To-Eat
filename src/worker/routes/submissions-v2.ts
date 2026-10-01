import { Hono } from 'hono';
import type { Context } from 'hono';
import { missingSubmissionConfig, publicationEnabled } from '../config.js';
import { verifyTurnstile } from '../security.js';
import { markMediaReservation, mediaObjectKey, privateMediaResponse, putPrivateMedia, readLimitedBody, reserveMediaAttempt, reserveMediaPut, sha256Bytes, validateImageMetadata, validateWebp } from '../media.js';
import { sha256 } from './submissions.js';
import { validateV2Submission, V2ValidationError, type V2Submission } from '../v2-validation.js';
import type { AppEnv } from '../types.js';

export const submissionV2Routes = new Hono<AppEnv>();

submissionV2Routes.post('/', async (context) => {
  if (!publicationEnabled(context.env) || missingSubmissionConfig(context.env).length) return unavailable(context);
  const declaredLength = Number(context.req.header('Content-Length') ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) return error(context, 'request_too_large', '请求体超过限制。', 413);
  const body = await readLimitedBody(context.req.raw, MAX_REQUEST_BYTES);
  if (body.tooLarge) return error(context, 'request_too_large', '请求体超过限制。', 413);
  const value = parseJson(body.bytes);
  if (!value) return error(context, 'invalid_json', '请求格式无效。', 400);
  let submission: V2Submission;
  try { submission = validateV2Submission(value); } catch (cause) { return error(context, cause instanceof V2ValidationError ? cause.code : 'invalid_submission', '投稿内容无效。', 422); }
  const ip = context.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipHash = await sha256(ip);
  const idempotencyKey = context.req.header('Idempotency-Key');
  if (idempotencyKey && !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return error(context, 'invalid_idempotency_key', '重复提交标识无效。', 400);
  const requestHash = await sha256(JSON.stringify({ schemaVersion: 2, entityType: submission.entityType, snapshotId: submission.snapshotId, public: submission.publicJson, parentVenueId: submission.parentVenueId, expectedImages: submission.expectedImages, expectedReviewImages: submission.expectedReviewImages }));
  const keyHash = idempotencyKey ? await sha256(`${ipHash}:${idempotencyKey}`) : null;
  if (keyHash) {
    try {
      const existing = await context.env.DB.prepare('SELECT submission_id, request_hash FROM submission_idempotency WHERE key_hash = ?').bind(keyHash).first<{ submission_id: string; request_hash: string }>();
      if (existing) return replayOrConflict(context, existing, requestHash);
    } catch { return unavailable(context); }
  }
  const snapshot = await resolveSnapshot(context.env.DB, submission.snapshotId);
  if (!snapshot) return error(context, 'snapshot_unavailable', '目录快照已变化，请刷新页面后重试。', 409);
  submission = { ...submission, snapshotId: snapshot, publicJson: { ...submission.publicJson, snapshotId: snapshot } };
  const parentCheck = await validateReferences(context.env, submission);
  if (!parentCheck.ok) return error(context, parentCheck.code, parentCheck.message, parentCheck.status);
  if (!await verifyTurnstile(submission.turnstileToken, context.env.TURNSTILE_SECRET_KEY, ip, context.env.TURNSTILE_HOSTNAME)) return error(context, 'challenge_failed', '请完成人机验证后重试。', 400);
  const windowStart = Math.floor(Math.floor(Date.now() / 1000) / 3600) * 3600;
  if (!await consumeRateLimit(context.env.DB, ipHash, windowStart)) return error(context, 'rate_limited', '提交较为频繁，请稍后重试。', 429, { 'Retry-After': '3600' });
  const id = crypto.randomUUID();
  const entityId = crypto.randomUUID();
  const attachedReviewId = submission.attachedReview ? crypto.randomUUID() : null;
  const receiptToken = crypto.randomUUID();
  const receiptHash = await sha256(receiptToken);
  const parentReceiptHash = parentCheck.parentReceiptHash;
  const createdAt = new Date().toISOString();
  const uploadState = submission.expectedImages || submission.expectedReviewImages ? 'uploading' : 'pending';
  const publicJson = JSON.stringify(submission.publicJson);
  const type = submission.entityType === 'review' ? 'review' : 'new';
  try {
    const statements = [
      context.env.DB.prepare('INSERT INTO submissions (id, type, target_restaurant_id, original_json, revision_json, receipt_hash, status, version, created_at, updated_at, schema_version, entity_type, entity_id, upload_state, expected_images, expected_review_images, snapshot_id, parent_entity_id, parent_receipt_hash, private_json, attached_review_id) VALUES (?, ?, ?, ?, ?, ?, \'pending\', 1, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(id, type, submission.entityType === 'review' ? String(submission.payload.targetId) : submission.parentVenueId, publicJson, publicJson, receiptHash, createdAt, createdAt, submission.entityType, entityId, uploadState, submission.expectedImages, submission.expectedReviewImages, submission.snapshotId, submission.parentVenueId, parentReceiptHash, JSON.stringify({ parentReceiptHash, parentEntityId: submission.parentVenueId }), attachedReviewId),
      ...(keyHash ? [context.env.DB.prepare('INSERT INTO submission_idempotency (key_hash, submission_id, request_hash, created_at) VALUES (?, ?, ?, ?)').bind(keyHash, id, requestHash, createdAt)] : []),
      ...entityStatement(context.env.DB, submission, id, entityId, submission.snapshotId, requestHash, createdAt),
      ...(attachedReviewId ? [reviewStatement(context.env.DB, id, attachedReviewId, entityId, submission.entityType === 'food' ? 'food' : 'venue', submission.attachedReview!, submission.snapshotId, requestHash, createdAt)] : []),
      ...await tagStatements(context.env.DB, submission.entityType, entityId, submission.payload.tags, createdAt),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'submit', 1, ?, ?)").bind(crypto.randomUUID(), id, `v2:${submission.entityType}`, createdAt),
    ];
    await context.env.DB.batch(statements);
  } catch {
    await releaseRateLimit(context.env.DB, ipHash, windowStart).catch(() => undefined);
    if (keyHash) {
      try {
        const existing = await context.env.DB.prepare('SELECT submission_id, request_hash FROM submission_idempotency WHERE key_hash = ?').bind(keyHash).first<{ submission_id: string; request_hash: string }>();
        if (existing) return replayOrConflict(context, existing, requestHash);
      } catch { /* Keep the public error generic. */ }
    }
    return unavailable(context);
  }
  return context.json({ submissionId: id, entityId, status: uploadState, version: 1, expectedImages: submission.expectedImages, expectedReviewImages: submission.expectedReviewImages, uploadedImages: 0, receiptToken }, 202, { 'Cache-Control': 'no-store' });
});

submissionV2Routes.get('/:id/status', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const receipt = await findByReceipt(context.env, context.req.param('id'), context.req.header('Authorization'));
  if (!receipt) return notFound(context);
  const counts = await imageCounts(context.env.DB, receipt.id);
  return context.json({ submissionId: receipt.id, entityId: receipt.entity_id, entityType: receipt.entity_type, status: receipt.status, uploadState: receipt.upload_state, version: receipt.version, expectedImages: receipt.expected_images, expectedReviewImages: receipt.expected_review_images, uploadedImages: counts.entity, uploadedReviewImages: counts.attachedReview }, 200, { 'Cache-Control': 'no-store' });
});

submissionV2Routes.post('/:id/images', async (context) => {
  if (!publicationEnabled(context.env) || context.env.MEDIA_MODE !== 'r2' || !context.env.IMAGES) return unavailable(context, 'media_storage_unavailable', '图片存储尚未配置完成。');
  const receipt = await findByReceipt(context.env, context.req.param('id'), context.req.header('Authorization'));
  if (!receipt || receipt.schema_version !== 2) return notFound(context);
  if (receipt.upload_state !== 'uploading') return error(context, 'images_not_expected', '该投稿当前不需要上传图片。', 409);
  if (!await reserveMediaAttempt(context.env.DB)) return unavailable(context, 'media_operation_quota_exceeded', '今日图片上传尝试次数已用尽，请稍后重试。');
  const contentLength = Number(context.req.header('Content-Length') ?? 0);
  if (contentLength > MAX_IMAGE_BYTES) return error(context, 'image_too_large', '图片超过大小限制。', 413);
  const contentType = (context.req.header('Content-Type') ?? '').split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'image/webp') return error(context, 'invalid_image_type', '只接受 WebP 图片。', 415);
  const metadata = validateImageMetadata(context.req.raw.headers);
  if (!metadata) return error(context, 'invalid_image_metadata', '图片来源、版权或替代文本声明无效。', 422);
  const slot = context.req.header('X-Image-Slot') === 'attachedReview' ? 'attachedReview' : context.req.header('X-Image-Slot') === 'entity' ? 'entity' : null;
  if (receipt.entity_type === 'food' && slot === 'entity' && metadata.isIllustrative) return error(context, 'food_photo_must_be_real', '餐品照片必须是对应餐品的实拍图。', 422);
  const slotIndex = Number(context.req.header('X-Image-Index') ?? -1);
  if (!slot || !Number.isInteger(slotIndex) || slotIndex < 0 || !validSlot(receipt, slot, slotIndex)) return error(context, 'invalid_image_slot', '图片槽位无效。', 422);
  const expectedVersion = optionalVersion(context.req.header('X-Submission-Version') ?? null);
  if (expectedVersion !== null && expectedVersion !== receipt.version) return error(context, 'version_conflict', '投稿版本已变化，请刷新后重试。', 409);
  const body = await readLimitedBody(context.req.raw, MAX_IMAGE_BYTES);
  if (body.tooLarge) return error(context, 'image_too_large', '图片超过大小限制。', 413);
  if (!body.bytes?.length) return error(context, 'invalid_image', '图片内容为空。', 422);
  let dimensions;
  try { dimensions = validateWebp(body.bytes); } catch (cause) { return error(context, cause instanceof Error ? cause.message : 'invalid_webp', '图片格式或尺寸无效。', 422); }
  const counts = await imageCounts(context.env.DB, receipt.id);
  if ((slot === 'entity' ? counts.entity : counts.attachedReview) >= (slot === 'entity' ? receipt.expected_images : receipt.expected_review_images)) return error(context, 'image_count_exceeded', '图片数量超过声明值。', 409);
  const duplicate = await context.env.DB.prepare('SELECT id FROM media_assets WHERE submission_id = ? AND slot = ? AND slot_index = ?').bind(receipt.id, slot, slotIndex).first<{ id: string }>();
  if (duplicate) return error(context, 'image_slot_used', '该图片槽位已经上传。', 409);
  const assetId = crypto.randomUUID();
  const objectKey = mediaObjectKey(assetId);
  if (!await reserveMediaPut(context.env.DB, assetId, receipt.id, body.bytes.byteLength)) return unavailable(context, 'media_quota_exceeded', '图片存储额度已用尽，请稍后重试。');
  try {
    await putPrivateMedia(context.env, assetId, body.bytes, metadata, slot === 'attachedReview' ? 'review' : receipt.entity_type, slot === 'attachedReview' ? String(receipt.attached_review_id) : receipt.entity_id, slot, slotIndex);
    const inserted = await context.env.DB.batch([
      context.env.DB.prepare('INSERT INTO media_assets (id, submission_id, entity_type, entity_id, slot, slot_index, object_key, content_type, byte_size, width, height, alt, source, source_note, copyright_holder, license, permission, rights_confirmed, is_illustrative, object_state, schema_version, created_at, content_hash, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, \'image/webp\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'private\', 2, ?, ?, ?)').bind(assetId, receipt.id, slot === 'attachedReview' ? 'review' : receipt.entity_type, slot === 'attachedReview' ? String(receipt.attached_review_id) : receipt.entity_id, slot, slotIndex, objectKey, body.bytes.byteLength, dimensions.width, dimensions.height, metadata.alt, metadata.source, metadata.sourceNote, metadata.copyrightHolder, metadata.license, metadata.permission, metadata.rightsConfirmed ? 1 : 0, metadata.isIllustrative ? 1 : 0, new Date().toISOString(), await sha256Bytes(body.bytes), JSON.stringify(metadata)),
      context.env.DB.prepare('UPDATE submissions SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND upload_state = \'uploading\'').bind(new Date().toISOString(), receipt.id, receipt.version),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'image_upload', ?, ?, ?)").bind(crypto.randomUUID(), receipt.id, receipt.version + 1, `${slot}:${slotIndex}`, new Date().toISOString()),
      context.env.DB.prepare("UPDATE media_reservations SET state = 'committed', updated_at = ? WHERE asset_id = ? AND state = 'reserved'").bind(new Date().toISOString(), assetId),
    ]);
    if (inserted.length !== 4 || inserted.some((entry) => !entry?.meta?.changes)) throw new Error('version_conflict');
  } catch (cause) {
    // Keep a failed object private and its reservation auditable for cleanup.
    await markMediaReservation(context.env.DB, assetId, 'orphan', cause instanceof Error && cause.message === 'version_conflict' ? 'version_conflict' : 'media_write_failed').catch(() => undefined);
    await context.env.DB.prepare("UPDATE media_assets SET object_state = 'deleted' WHERE id = ? AND object_state = 'private'").bind(assetId).run().catch(() => undefined);
    if (cause instanceof Error && cause.message === 'version_conflict') return error(context, 'version_conflict', '投稿版本已变化，请刷新后重试。', 409);
    await context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'upload_failed', ?, ?, ?)").bind(crypto.randomUUID(), receipt.id, receipt.version, 'media_upload_failed', new Date().toISOString()).run().catch(() => undefined);
    return unavailable(context, 'media_upload_failed', '图片暂时无法保存，请稍后重试。');
  }
  return context.json({ assetId, status: 'private', slot, slotIndex, width: dimensions.width, height: dimensions.height, version: receipt.version + 1 }, 201, { 'Cache-Control': 'no-store' });
});

submissionV2Routes.post('/:id/finalize', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const receipt = await findByReceipt(context.env, context.req.param('id'), context.req.header('Authorization'));
  if (!receipt || receipt.schema_version !== 2) return notFound(context);
  const body = await readLimitedBody(context.req.raw, 16 * 1024);
  const value = parseJson(body.bytes);
  if (!value || !Number.isSafeInteger(value.expectedVersion)) return error(context, 'invalid_finalize', '完成请求的版本号无效。', 422);
  if (value.expectedImages !== undefined && value.expectedImages !== receipt.expected_images || value.expectedReviewImages !== undefined && value.expectedReviewImages !== receipt.expected_review_images) return error(context, 'image_count_mismatch', '完成请求的图片声明与投稿不一致。', 409);
  if (Number(value.expectedVersion) !== receipt.version) return error(context, 'version_conflict', '投稿版本已变化，请刷新后重试。', 409);
  if (!receipt.expected_images && !receipt.expected_review_images && receipt.upload_state === 'pending') return context.json({ submissionId: receipt.id, status: 'pending', version: receipt.version, uploadedImages: 0, uploadedReviewImages: 0 }, 200, { 'Cache-Control': 'no-store' });
  const counts = await imageCounts(context.env.DB, receipt.id);
  if (counts.entity !== receipt.expected_images || counts.attachedReview !== receipt.expected_review_images) return error(context, 'image_count_mismatch', '图片数量尚未完成。', 409);
  if (receipt.upload_state === 'pending') return context.json({ submissionId: receipt.id, status: 'pending', version: receipt.version, uploadedImages: counts.entity, uploadedReviewImages: counts.attachedReview }, 200, { 'Cache-Control': 'no-store' });
  const now = new Date().toISOString();
  const result = await context.env.DB.batch([
    context.env.DB.prepare("UPDATE submissions SET upload_state = 'pending', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND upload_state = 'uploading'").bind(now, receipt.id, receipt.version),
    context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'image_finalize', ?, NULL, ?)").bind(crypto.randomUUID(), receipt.id, receipt.version + 1, now),
  ]).catch(() => null);
  if (!result || result.length !== 2 || result.some((entry) => !entry?.meta?.changes)) return error(context, 'version_conflict', '投稿版本已变化，请刷新后重试。', 409);
  return context.json({ submissionId: receipt.id, status: 'pending', version: receipt.version + 1, uploadedImages: counts.entity, uploadedReviewImages: counts.attachedReview }, 200, { 'Cache-Control': 'no-store' });
});

submissionV2Routes.get('/:id/images/:assetId', async (context) => {
  if (!publicationEnabled(context.env) || context.env.MEDIA_MODE !== 'r2' || !context.env.IMAGES) return unavailable(context, 'media_storage_unavailable', '图片存储尚未配置完成。');
  const receipt = await findByReceipt(context.env, context.req.param('id'), context.req.header('Authorization'));
  if (!receipt) return notFound(context);
  const asset = await context.env.DB.prepare('SELECT id, object_key, object_state FROM media_assets WHERE id = ? AND submission_id = ?').bind(context.req.param('assetId'), receipt.id).first<{ id: string; object_key: string; object_state: string }>();
  if (!asset || !['private', 'published'].includes(asset.object_state)) return notFound(context);
  return privateMediaResponse(context.env, asset.object_key);
});

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

async function validateReferences(env: AppEnv['Bindings'], submission: V2Submission): Promise<{ ok: true; parentReceiptHash: string | null } | { ok: false; code: string; message: string; status: 403 | 404 | 409 | 422 }> {
  if (submission.entityType === 'venue' && submission.payload.parentId) {
    const parent = await env.DB.prepare("SELECT id FROM venues WHERE id = ? AND publication_state = 'published'").bind(submission.payload.parentId).first<{id:string}>();
    if(!parent) return {ok:false,code:'parent_venue_unavailable',message:'上级餐饮点不存在或尚未发布。',status:422};
  }
  if (submission.entityType === 'food') {
    const parent = await env.DB.prepare('SELECT id, publication_state, submission_id, snapshot_id FROM venues WHERE id = ?').bind(submission.parentVenueId).first<{ id: string; publication_state: string; submission_id: string | null; snapshot_id: string | null }>();
    if (!parent) return { ok: false, code: 'parent_venue_not_found', message: '所属店铺不存在，请重新选择。', status: 422 };
    if (parent.publication_state === 'published') {
      const publishedSnapshot = await mirrorSnapshot(env.DB, 'venue', parent.id);
      return publishedSnapshot === submission.snapshotId ? { ok: true, parentReceiptHash: null } : { ok: false, code: 'snapshot_conflict', message: '所属店铺的目录已更新，请刷新页面。', status: 409 };
    }
    if (parent.snapshot_id && parent.snapshot_id !== submission.snapshotId) return { ok: false, code: 'snapshot_conflict', message: '所属店铺的目录已更新，请刷新页面。', status: 409 };
    if (parent.publication_state !== 'pending' || !parent.submission_id || !submission.parentReceiptToken) return { ok: false, code: 'parent_venue_unavailable', message: '所属店铺尚未发布，请通过自己的店铺投稿回执添加餐品。', status: 409 };
    const hash = await sha256(submission.parentReceiptToken);
    const owner = await env.DB.prepare("SELECT id FROM submissions WHERE id = ? AND receipt_hash = ? AND status = 'pending' AND schema_version = 2").bind(parent.submission_id, hash).first<{ id: string }>();
    if (!owner) return { ok: false, code: 'parent_receipt_invalid', message: '店铺投稿回执无效。', status: 403 };
    return { ok: true, parentReceiptHash: hash };
  }
  if (submission.entityType === 'review') {
    const targetType = String(submission.payload.targetType);
    const table = targetType === 'venue' ? 'venues' : 'foods';
    const target = await env.DB.prepare(`SELECT id, snapshot_id FROM ${table} WHERE id = ? AND publication_state = 'published'`).bind(submission.payload.targetId).first<{ id: string; snapshot_id: string | null }>();
    if (!target) return { ok: false, code: 'review_target_unavailable', message: '评价目标不存在或尚未发布。', status: 409 };
    const publishedSnapshot = await mirrorSnapshot(env.DB, targetType as 'venue' | 'food', String(submission.payload.targetId));
    if (publishedSnapshot !== submission.snapshotId) return { ok: false, code: 'snapshot_conflict', message: '评价目标的目录快照已变化。', status: 409 };
  }
  return { ok: true, parentReceiptHash: null };
}

async function mirrorSnapshot(db: D1Database, entityType: 'venue' | 'food', entityId: string): Promise<string | null> {
  const row = await db.prepare('SELECT snapshot_id FROM catalog_mirror WHERE entity_type = ? AND entity_id = ?').bind(entityType, entityId).first<{ snapshot_id: string }>().catch(() => null);
  return row?.snapshot_id ?? null;
}

async function resolveSnapshot(db: D1Database, requested: string): Promise<string | null> {
  if (requested === 'catalog-v2') {
    const current = await db.prepare("SELECT id FROM catalog_snapshots WHERE status = 'published' ORDER BY generated_at DESC LIMIT 1").first<{ id: string }>().catch(() => null);
    return current?.id ?? null;
  }
  if (!/^catalog-v2-[a-f0-9]{16,64}$/i.test(requested)) return null;
  const row = await db.prepare("SELECT id FROM catalog_snapshots WHERE id = ? AND status = 'published'").bind(requested).first<{ id: string }>().catch(() => null);
  return row?.id ?? null;
}

function entityStatement(db: D1Database, submission: V2Submission, submissionId: string, entityId: string, snapshotId: string, contentHash: string, now: string) {
  const value = submission.payload;
  if (submission.entityType === 'venue') {
    const location = value.location && typeof value.location === 'object' && !Array.isArray(value.location) ? value.location as Record<string, unknown> : value;
    const coordinates = coordinatesOf(location.coordinates ?? value.coordinates);
    const price = priceOf(value.averagePrice);
    return [db.prepare('INSERT INTO venues (id, submission_id, type, campus_scope, name, address, campus, floor, latitude, longitude, distance_m, average_price, average_price_min, average_price_max, average_price_currency, average_price_unit, average_price_source, average_price_verified_at, landmark, distance_basis, provenance_json, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, \'pending\', ?, ?, ?, ?)').bind(entityId, submissionId, String(value.type ?? value.kind), String(value.campusScope ?? value.category), String(value.name).trim(), String(location.address).trim(), optional(location.campusArea ?? value.campus), optional(location.floor ?? value.floor), coordinates?.latitude ?? null, coordinates?.longitude ?? null, numberOrNull(location.distanceM ?? location.distanceMeters ?? value.distanceM ?? value.distance), price.amount, price.minimum, price.maximum, price.currency, price.unit, price.source, price.verifiedAt, optional(location.landmark), optional(location.distanceBasis), JSON.stringify({ source: price.source, snapshotId }), snapshotId, contentHash, now, now)];
  }
  if (submission.entityType === 'food') {
    const price = priceOf(value.price);
    const mealTypes = Array.isArray(value.mealTypes) ? value.mealTypes.map(String) : (value.mealType ? [String(value.mealType)] : []);
    return [db.prepare('INSERT INTO foods (id, submission_id, venue_id, name, meal_type, meal_types_json, description, price, price_min, price_max, price_currency, price_unit, price_source, price_verified_at, provenance_json, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 2, \'pending\', ?, ?, ?, ?)').bind(entityId, submissionId, submission.parentVenueId, String(value.name).trim(), mealTypes[0] ?? null, JSON.stringify(mealTypes), optional(value.description), price.amount, price.minimum, price.maximum, price.currency, price.unit, price.source, price.verifiedAt, JSON.stringify({ source: price.source, snapshotId }), snapshotId, contentHash, now, now), ...mealTypes.map((mealType, ordinal) => db.prepare('INSERT INTO food_meal_types (food_id, meal_type, ordinal) VALUES (?, ?, ?)').bind(entityId, mealType, ordinal))];
  }
  const targetType = String(value.targetType);
  return [db.prepare('INSERT INTO reviews (id, submission_id, target_type, target_id, rating, text, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 2, \'pending\', ?, ?, ?, ?)').bind(entityId, submissionId, targetType, String(value.targetId), Number(value.rating), String(value.text ?? ''), snapshotId, contentHash, now, now)];
}

function reviewStatement(db: D1Database, submissionId: string, reviewId: string, entityId: string, targetType: string, review: { rating: number; text: string }, snapshotId: string, contentHash: string, now: string) {
  return db.prepare('INSERT INTO reviews (id, submission_id, target_type, target_id, rating, text, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 2, \'pending\', ?, ?, ?, ?)').bind(reviewId, submissionId, targetType, entityId, review.rating, review.text, snapshotId, contentHash, now, now);
}

async function tagStatements(db: D1Database, entityType: string, entityId: string, value: unknown, now: string) {
  if (!Array.isArray(value)) return [];
  const statements = [];
  for (const item of value) {
    const tagKey = String(item).trim().toLowerCase();
    const tagId = `tag-${(await sha256(tagKey)).slice(0, 32)}`;
    statements.push(db.prepare('INSERT INTO tags (id, tag_key, label, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(tag_key) DO NOTHING').bind(tagId, tagKey, String(item).trim(), now));
    statements.push(db.prepare('INSERT INTO entity_tags (entity_type, entity_id, tag_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(entityType, entityId, tagId));
  }
  return statements;
}

async function consumeRateLimit(db: D1Database, ipHash: string, windowStart: number): Promise<boolean> {
  const result = await db.prepare('INSERT INTO rate_limits (key_hash, window_start, request_count) VALUES (?, ?, 1) ON CONFLICT (key_hash, window_start) DO UPDATE SET request_count = request_count + 1 WHERE request_count < 5').bind(ipHash, windowStart).run();
  return Boolean(result.meta.changes);
}

async function releaseRateLimit(db: D1Database, ipHash: string, windowStart: number): Promise<void> {
  await db.prepare('UPDATE rate_limits SET request_count = CASE WHEN request_count > 0 THEN request_count - 1 ELSE 0 END WHERE key_hash = ? AND window_start = ?').bind(ipHash, windowStart).run();
}

async function findByReceipt(env: AppEnv['Bindings'], id: string, authorization: string | undefined) {
  const token = authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!token) return null;
  const hash = await sha256(token);
  return env.DB.prepare('SELECT id, schema_version, entity_type, entity_id, attached_review_id, status, version, upload_state, expected_images, expected_review_images FROM submissions WHERE id = ? AND receipt_hash = ?').bind(id, hash).first<{ id: string; schema_version: number; entity_type: string; entity_id: string; attached_review_id: string | null; status: string; version: number; upload_state: string; expected_images: number; expected_review_images: number }>();
}

async function imageCounts(db: D1Database, submissionId: string) {
  const result = await db.prepare('SELECT slot, COUNT(*) AS count FROM media_assets WHERE submission_id = ? AND object_state != \'deleted\' GROUP BY slot').bind(submissionId).all<{ slot: string; count: number }>();
  return { entity: Number(result.results.find((row) => row.slot === 'entity')?.count ?? 0), attachedReview: Number(result.results.find((row) => row.slot === 'attachedReview')?.count ?? 0) };
}

function validSlot(receipt: { entity_type: string; attached_review_id: string | null; expected_images: number; expected_review_images: number }, slot: string, index: number) { return slot === 'entity' ? index < receipt.expected_images : receipt.attached_review_id !== null && index < receipt.expected_review_images && receipt.entity_type !== 'review'; }


function parseJson(bytes: Uint8Array | null): Record<string, any> | null { if (!bytes?.length) return null; try { const value = JSON.parse(new TextDecoder().decode(bytes)) as unknown; return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : null; } catch { return null; } }
function optionalVersion(value: string | null): number | null { if (value === null || value === '') return null; return /^\d+$/.test(value) ? Number(value) : -1; }
function coordinatesOf(value: unknown) { if (Array.isArray(value)) return { latitude: numberOrNull(value[0]), longitude: numberOrNull(value[1]) }; return null; }
function numberOrNull(value: unknown): number | null { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
function optional(value: unknown): string | null { return typeof value === 'string' ? value : null; }
function priceOf(value: unknown) { if (value && typeof value === 'object') { const item = value as Record<string, unknown>; return { amount: numberOrNull(item.amountCents), minimum: numberOrNull(item.minCents), maximum: numberOrNull(item.maxCents), currency: optional(item.currency) ?? 'CNY', unit: optional(item.unit) ?? '人', source: optional(item.source), verifiedAt: optional(item.verifiedAt) }; } return { amount: null, minimum: null, maximum: null, currency: 'CNY', unit: '人', source: null, verifiedAt: null }; }
function replayOrConflict(context: Context<AppEnv>, existing: { submission_id: string; request_hash: string }, requestHash: string) { return existing.request_hash === requestHash ? error(context, 'idempotency_replayed', '该重复提交标识已经使用，请使用首次响应中的回执令牌查询状态。', 409, undefined, { submissionId: existing.submission_id }) : error(context, 'idempotency_conflict', '重复提交标识已用于另一份稿件。', 409); }
function unavailable(context: Context<AppEnv>, code = 'service_unavailable', message = '投稿服务暂未配置完成，请稍后重试。') { return error(context, code, message, 503); }
function notFound(context: Context<AppEnv>) { return error(context, 'not_found', '没有找到该投稿。', 404); }
function error(context: Context<AppEnv>, code: string, message: string, status: 400 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503, headers?: Record<string, string>, extra?: Record<string, unknown>) { return context.json({ ...(extra ?? {}), error: { code, message } }, status, { 'Cache-Control': 'no-store', ...(headers ?? {}) }); }
