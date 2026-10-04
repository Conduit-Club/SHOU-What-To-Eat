import { Hono } from 'hono';
import type { Context } from 'hono';
import { missingSubmissionConfig, publicationEnabled, liveContent } from '../config.js';
import { verifyTurnstile } from '../security.js';
import { markMediaReservation, mediaObjectKey, privateMediaResponse, putPrivateMedia, readLimitedBody, reserveMediaAttempt, reserveMediaPut, sha256Bytes, validateImageMetadata, validateWebp } from '../media.js';
import { sha256 } from './submissions.js';
import { validateV2Submission, V2ValidationError, type V2Submission } from '../v2-validation.js';
import type { AppEnv } from '../types.js';
import { publishLive } from '../live-catalog.js';
import type { AuthSession } from '../auth.js';
import { submissionActor, SubmissionAuthFailure, submissionSessionAssertion, submissionWriteAssertion } from '../submission-auth.js';
import { diningDate } from '../../utils/dining-date.js';
import { publicAvatar } from '../../utils/review-identity.js';
import { adminSessionValid, adminWriteBatch } from '../admin-auth.js';

export const submissionV2Routes = new Hono<AppEnv>();
submissionV2Routes.onError((cause, context) => {
  if (cause instanceof SubmissionAuthFailure) return error(context, cause.code, cause.message, cause.status);
  throw cause;
});

submissionV2Routes.post('/', async (context) => {
  if (!publicationEnabled(context.env) || missingSubmissionConfig(context.env).length) return unavailable(context);
  const actor = await submissionActor(context);
  const direct = Boolean(actor && liveContent(context.env));
  const declaredLength = Number(context.req.header('Content-Length') ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) return error(context, 'request_too_large', '请求体超过限制。', 413);
  const body = await readLimitedBody(context.req.raw, MAX_REQUEST_BYTES);
  if (body.tooLarge) return error(context, 'request_too_large', '请求体超过限制。', 413);
  const value = parseJson(body.bytes);
  if (!value) return error(context, 'invalid_json', '请求格式无效。', 400);
  let submission: V2Submission;
  try { submission = validateV2Submission(value); } catch (cause) { return error(context, cause instanceof V2ValidationError ? cause.code : 'invalid_submission', cause instanceof V2ValidationError && cause.code === 'future_visitedAt' ? '用餐日期不能晚于今天（UTC+8），请选择今天或之前的实际日期。' : '投稿内容无效。', 422); }
  if (submission.visibility === 'username' && !actor) return error(context, 'login_required', '请先登录，才能使用账号用户名发表。', 401);
  const publicAuthor = actor && submission.visibility === 'username' ? actor.username : null;
  const publicAuthorAvatar = publicAuthor ? publicAvatar(actor?.picture) : null;
  const ip = context.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipHash = await sha256(ip);
  const idempotencyKey = context.req.header('Idempotency-Key');
  if (idempotencyKey && !/^[A-Za-z0-9_-]{16,100}$/.test(idempotencyKey)) return error(context, 'invalid_idempotency_key', '重复提交标识无效。', 400);
  const requestHash = await sha256(JSON.stringify({ schemaVersion: 2, entityType: submission.entityType, snapshotId: submission.snapshotId, public: submission.publicJson, parentVenueId: submission.parentVenueId, expectedImages: submission.expectedImages, expectedReviewImages: submission.expectedReviewImages, ...(submission.visibility === 'username' ? { visibility: 'username' } : {}) }));
  const keyHash = idempotencyKey ? await sha256(`${actor ? `user:${actor.userId}` : ipHash}:${idempotencyKey}`) : null;
  if (keyHash) {
    try {
      const existing = await context.env.DB.prepare('SELECT submission_id, request_hash FROM submission_idempotency WHERE key_hash = ?').bind(keyHash).first<{ submission_id: string; request_hash: string }>();
      if (existing) return replayOrConflict(context, existing, requestHash);
    } catch { return unavailable(context); }
  }
  if (direct && submission.entityType === 'venue' && actor?.wasAdmin && !actor.isAdmin) return adminRenewal(context);
  // The raw request hash precedes defaults: a retry across midnight matches the
  // original request. The saved date and identity are captured only once here.
  const createdAt = new Date().toISOString();
  const today = diningDate(Date.parse(createdAt));
  const attachedReview = submission.attachedReview ? { ...submission.attachedReview, visitedAt: submission.attachedReview.visitedAt ?? today } : null;
  const payload = { ...submission.payload,
    ...(submission.entityType === 'review' ? { visitedAt: submission.payload.visitedAt ?? today, authorAlias: publicAuthor } : {}),
    ...(attachedReview ? { attachedReview } : {}),
  };
  submission = { ...submission, payload, attachedReview, publicJson: { ...submission.publicJson, payload } };
  const snapshot = await resolveSnapshot(context.env.DB, submission.snapshotId);
  if (!snapshot) return error(context, 'snapshot_unavailable', '目录快照已变化，请刷新页面后重试。', 409);
  submission = { ...submission, snapshotId: snapshot, publicJson: { ...submission.publicJson, snapshotId: snapshot } };
  const parentCheck = await validateReferences(context.env, submission, direct);
  if (!parentCheck.ok) return error(context, parentCheck.code, parentCheck.message, parentCheck.status);
  if (!await verifyTurnstile(submission.turnstileToken, context.env.TURNSTILE_SECRET_KEY, ip, context.env.TURNSTILE_HOSTNAME)) return error(context, 'challenge_failed', '请完成人机验证后重试。', 400);
  const windowStart = Math.floor(Math.floor(Date.now() / 1000) / 3600) * 3600;
  if (!await consumeRateLimit(context.env.DB, ipHash, windowStart)) return error(context, 'rate_limited', '提交较为频繁，请稍后重试。', 429, { 'Retry-After': '3600' });
  const accountRateKey = actor ? await sha256(`eat-submitter:${actor.userId}`) : null;
  if (accountRateKey && !await consumeRateLimit(context.env.DB, accountRateKey, windowStart)) {
    await releaseRateLimit(context.env.DB, ipHash, windowStart).catch(() => undefined);
    return error(context, 'rate_limited', '本账号提交较为频繁，请稍后重试。', 429, { 'Retry-After': '3600' });
  }
  const id = crypto.randomUUID();
  const entityId = crypto.randomUUID();
  const attachedReviewId = submission.attachedReview ? crypto.randomUUID() : null;
  const receiptToken = crypto.randomUUID();
  const receiptHash = await sha256(receiptToken);
  const parentReceiptHash = parentCheck.parentReceiptHash;
  const uploadState = submission.expectedImages || submission.expectedReviewImages ? 'uploading' : 'pending';
  const publicJson = JSON.stringify(submission.publicJson);
  const type = submission.entityType === 'review' ? 'review' : 'new';
  const adminDirect = direct && submission.entityType === 'venue' && Boolean(actor?.isAdmin);
  const publicationMode = direct && (submission.entityType !== 'venue' || adminDirect) ? 'direct' : 'moderated';
  try {
    const statements = [
      ...(actor ? [submissionSessionAssertion(context.env, actor)] : []),
      context.env.DB.prepare('INSERT INTO submissions (id, type, target_restaurant_id, original_json, revision_json, receipt_hash, status, version, created_at, updated_at, schema_version, entity_type, entity_id, upload_state, expected_images, expected_review_images, snapshot_id, parent_entity_id, parent_receipt_hash, private_json, attached_review_id, submitter_user_id, publication_mode, public_author_alias, public_identity_recorded, public_author_avatar) VALUES (?, ?, ?, ?, ?, ?, \'pending\', 1, ?, ?, 2, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)').bind(id, type, submission.entityType === 'review' ? String(submission.payload.targetId) : submission.parentVenueId, publicJson, publicJson, receiptHash, createdAt, createdAt, submission.entityType, entityId, uploadState, submission.expectedImages, submission.expectedReviewImages, submission.snapshotId, submission.parentVenueId, parentReceiptHash, JSON.stringify({ parentReceiptHash, parentEntityId: submission.parentVenueId }), attachedReviewId, actor?.userId ?? null, publicationMode, publicAuthor, publicAuthorAvatar),
      ...(keyHash ? [context.env.DB.prepare('INSERT INTO submission_idempotency (key_hash, submission_id, request_hash, created_at) VALUES (?, ?, ?, ?)').bind(keyHash, id, requestHash, createdAt)] : []),
      ...entityStatement(context.env.DB, submission, id, entityId, submission.snapshotId, requestHash, createdAt),
      ...(attachedReviewId ? [reviewStatement(context.env.DB, id, attachedReviewId, entityId, submission.entityType === 'food' ? 'food' : 'venue', submission.attachedReview!, submission.snapshotId, requestHash, createdAt)] : []),
      ...await tagStatements(context.env.DB, submission.entityType, entityId, submission.payload.tags, createdAt),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'submit', 1, ?, ?)").bind(crypto.randomUUID(), id, `v2:${submission.entityType}`, createdAt),
      ...(actor ? [context.env.DB.prepare('DELETE FROM live_write_assertion')] : []),
    ];
    await adminWriteBatch(context.env, statements, adminDirect ? actor! : undefined);
  } catch {
    await releaseRateLimit(context.env.DB, ipHash, windowStart).catch(() => undefined);
    if (accountRateKey) await releaseRateLimit(context.env.DB, accountRateKey, windowStart).catch(() => undefined);
    if (keyHash) {
      try {
        const existing = await context.env.DB.prepare('SELECT submission_id, request_hash FROM submission_idempotency WHERE key_hash = ?').bind(keyHash).first<{ submission_id: string; request_hash: string }>();
        if (existing) return replayOrConflict(context, existing, requestHash);
      } catch { /* Keep the public error generic. */ }
    }
    if (adminDirect && await adminSessionValid(context.env, actor!).catch(() => undefined) === false) return adminRenewal(context);
    return unavailable(context);
  }
  let status: string = uploadState, version = 1;
  if (publicationMode === 'direct' && uploadState === 'pending' && actor) {
    try { await publishDirect(context.env, id, version, actor, submission.entityType); status = 'published'; version++; }
    catch { /* Return the private receipt: a saved draft can retry finalization. */ }
  }
  return context.json({ submissionId: id, entityId, status, uploadState, publicationMode, version, expectedImages: submission.expectedImages, expectedReviewImages: submission.expectedReviewImages, uploadedImages: 0, receiptToken }, status === 'published' ? 201 : 202, { 'Cache-Control': 'no-store' });
});

submissionV2Routes.get('/:id/status', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const receipt = await findByReceipt(context.env, context.req.param('id'), context.req.header('Authorization'));
  if (!receipt) return notFound(context);
  const counts = await imageCounts(context.env.DB, receipt.id);
  return context.json({ submissionId: receipt.id, entityId: receipt.entity_id, entityType: receipt.entity_type, status: receipt.live_published_at ? 'published' : receipt.status, uploadState: receipt.upload_state, publicationMode: receipt.publication_mode, version: receipt.version, expectedImages: receipt.expected_images, expectedReviewImages: receipt.expected_review_images, uploadedImages: counts.entity, uploadedReviewImages: counts.attachedReview }, 200, { 'Cache-Control': 'no-store' });
});

submissionV2Routes.post('/:id/images', async (context) => {
  if (!publicationEnabled(context.env) || context.env.MEDIA_MODE !== 'r2' || !context.env.IMAGES) return unavailable(context, 'media_storage_unavailable', '图片存储尚未配置完成。');
  const receipt = await findByReceipt(context.env, context.req.param('id'), context.req.header('Authorization'));
  if (!receipt || receipt.schema_version !== 2) return notFound(context);
  const actor = await submissionActor(context, receipt.submitter_user_id);
  if (receipt.upload_state !== 'uploading' || receipt.status !== 'pending') return error(context, 'images_not_expected', '该投稿当前不需要上传图片。', 409);
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
      ...(actor ? [submissionSessionAssertion(context.env, actor)] : []),
      context.env.DB.prepare('UPDATE submissions SET version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND upload_state = \'uploading\' AND status = \'pending\'').bind(new Date().toISOString(), receipt.id, receipt.version),
      submissionWriteAssertion(context.env.DB),
      context.env.DB.prepare('INSERT INTO media_assets (id, submission_id, entity_type, entity_id, slot, slot_index, object_key, content_type, byte_size, width, height, alt, source, source_note, copyright_holder, license, permission, rights_confirmed, is_illustrative, object_state, schema_version, created_at, content_hash, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, \'image/webp\', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, \'private\', 2, ?, ?, ?)').bind(assetId, receipt.id, slot === 'attachedReview' ? 'review' : receipt.entity_type, slot === 'attachedReview' ? String(receipt.attached_review_id) : receipt.entity_id, slot, slotIndex, objectKey, body.bytes.byteLength, dimensions.width, dimensions.height, metadata.alt, metadata.source, metadata.sourceNote, metadata.copyrightHolder, metadata.license, metadata.permission, metadata.rightsConfirmed ? 1 : 0, metadata.isIllustrative ? 1 : 0, new Date().toISOString(), await sha256Bytes(body.bytes), JSON.stringify(metadata)),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'image_upload', ?, ?, ?)").bind(crypto.randomUUID(), receipt.id, receipt.version + 1, `${slot}:${slotIndex}`, new Date().toISOString()),
      context.env.DB.prepare("UPDATE media_reservations SET state = 'committed', updated_at = ? WHERE asset_id = ? AND state = 'reserved'").bind(new Date().toISOString(), assetId),
      submissionWriteAssertion(context.env.DB),
      context.env.DB.prepare('DELETE FROM live_write_assertion'),
    ]);
    if (!inserted.length) throw new Error('version_conflict');
  } catch (cause) {
    // Keep a failed object private and its reservation auditable for cleanup.
    await markMediaReservation(context.env.DB, assetId, 'orphan', cause instanceof Error && cause.message === 'version_conflict' ? 'version_conflict' : 'media_write_failed').catch(() => undefined);
    await context.env.DB.prepare("UPDATE media_assets SET object_state = 'deleted' WHERE id = ? AND object_state = 'private'").bind(assetId).run().catch(() => undefined);
    if (cause instanceof Error && (cause.message === 'version_conflict' || cause.message.includes('CHECK constraint failed'))) return error(context, 'version_conflict', '投稿版本或登录状态已变化，请刷新后重试。', 409);
    await context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'upload_failed', ?, ?, ?)").bind(crypto.randomUUID(), receipt.id, receipt.version, 'media_upload_failed', new Date().toISOString()).run().catch(() => undefined);
    return unavailable(context, 'media_upload_failed', '图片暂时无法保存，请稍后重试。');
  }
  return context.json({ assetId, status: 'private', slot, slotIndex, width: dimensions.width, height: dimensions.height, version: receipt.version + 1 }, 201, { 'Cache-Control': 'no-store' });
});

submissionV2Routes.post('/:id/finalize', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const receipt = await findByReceipt(context.env, context.req.param('id'), context.req.header('Authorization'));
  if (!receipt || receipt.schema_version !== 2) return notFound(context);
  const actor = await submissionActor(context, receipt.submitter_user_id);
  const body = await readLimitedBody(context.req.raw, 16 * 1024);
  if (body.tooLarge) return error(context, 'request_too_large', '请求体超过限制。', 413);
  const value = parseJson(body.bytes);
  if (!value || !Number.isSafeInteger(value.expectedVersion) || value.expectedVersion < 1) return error(context, 'invalid_finalize', '完成请求的版本号无效。', 422);
  if (value.expectedImages !== undefined && value.expectedImages !== receipt.expected_images || value.expectedReviewImages !== undefined && value.expectedReviewImages !== receipt.expected_review_images) return error(context, 'image_count_mismatch', '完成请求的图片声明与投稿不一致。', 409);
  const counts = await imageCounts(context.env.DB, receipt.id);
  // A lost successful response may retry with the version before publication.
  // Return the committed result without publishing or auditing a second time.
  if (receipt.live_published_at) return finalizedResponse(context, receipt, counts, receipt.version, 'published');
  if (receipt.publication_mode === 'direct' && receipt.entity_type === 'venue' && !actor?.isAdmin) return adminRenewal(context);
  if (receipt.status !== 'pending') return error(context, 'submission_not_pending', '该投稿当前无法继续，请在进度页查看状态。', 409);
  if (Number(value.expectedVersion) !== receipt.version) return error(context, 'version_conflict', '投稿版本已变化，请刷新后重试。', 409);
  if (counts.entity !== receipt.expected_images || counts.attachedReview !== receipt.expected_review_images) return error(context, 'image_count_mismatch', '图片数量尚未完成。', 409);
  let version = receipt.version;
  if (receipt.upload_state !== 'pending') {
    const now = new Date().toISOString();
    const result = await context.env.DB.batch([
      ...(actor ? [submissionSessionAssertion(context.env, actor)] : []),
      context.env.DB.prepare("UPDATE submissions SET upload_state = 'pending', version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND upload_state = 'uploading' AND status='pending'").bind(now, receipt.id, receipt.version),
      submissionWriteAssertion(context.env.DB),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'image_finalize', ?, NULL, ?)").bind(crypto.randomUUID(), receipt.id, receipt.version + 1, now),
      context.env.DB.prepare('DELETE FROM live_write_assertion'),
    ]).catch(() => null);
    if (!result) return error(context, 'version_conflict', '投稿版本或登录状态已变化，请刷新后重试。', 409);
    version++;
  }
  if (receipt.publication_mode === 'direct') {
    if (!actor || actor.userId !== receipt.submitter_user_id) return error(context, 'submission_owner_required', '请使用原投稿账号公开这份投稿。', 403);
    if (!liveContent(context.env)) return unavailable(context, 'direct_publication_unavailable', '直接发表暂时不可用，请保留回执后重试。');
    try { await publishDirect(context.env, receipt.id, version, actor, receipt.entity_type); }
    catch (cause) {
      const code = publicationFailure(cause);
      if (code === 'admin_session_expired') return adminRenewal(context);
      return error(context, code, code === 'parent_venue_unpublished' ? '所属餐厅或档口尚未公开，请等待店铺审核通过后重试。' : code === 'review_target_unavailable' ? '评价目标已下架，暂时无法公开这条评价。' : '资料已保存，暂时无法公开，请保留回执并继续完成投稿。', code === 'publication_failed' ? 503 : 409);
    }
    return finalizedResponse(context, receipt, counts, version + 1, 'published');
  }
  return finalizedResponse(context, receipt, counts, version, 'pending');
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

async function validateReferences(env: AppEnv['Bindings'], submission: V2Submission, direct = false): Promise<{ ok: true; parentReceiptHash: string | null } | { ok: false; code: string; message: string; status: 403 | 404 | 409 | 422 }> {
  if (submission.entityType === 'venue' && submission.payload.parentId) {
    const parent = await env.DB.prepare("SELECT id FROM venues WHERE id = ? AND publication_state = 'published'").bind(submission.payload.parentId).first<{id:string}>();
    if(!parent) return {ok:false,code:'parent_venue_unavailable',message:'上级餐饮点不存在或尚未发布。',status:422};
  }
  if (submission.entityType === 'food') {
    const parent = await env.DB.prepare('SELECT id, publication_state, submission_id, snapshot_id FROM venues WHERE id = ?').bind(submission.parentVenueId).first<{ id: string; publication_state: string; submission_id: string | null; snapshot_id: string | null }>();
    if (!parent) return { ok: false, code: 'parent_venue_not_found', message: '所属店铺不存在，请重新选择。', status: 422 };
    if (parent.publication_state === 'published') {
      const publishedSnapshot = await mirrorSnapshot(env.DB, 'venue', parent.id);
      return (liveContent(env) || publishedSnapshot === submission.snapshotId) ? { ok: true, parentReceiptHash: null } : { ok: false, code: 'snapshot_conflict', message: '所属店铺的目录已更新，请刷新页面。', status: 409 };
    }
    if (direct) return { ok: false, code: 'parent_venue_unpublished', message: '所属餐厅或档口需先经管理员批准。请选择已公开店铺，或等待该店铺审核通过后再添加餐品。', status: 409 };
    if (!liveContent(env) && parent.snapshot_id && parent.snapshot_id !== submission.snapshotId) return { ok: false, code: 'snapshot_conflict', message: '所属店铺的目录已更新，请刷新页面。', status: 409 };
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
    if (!liveContent(env) && publishedSnapshot !== submission.snapshotId) return { ok: false, code: 'snapshot_conflict', message: '评价目标的目录快照已变化。', status: 409 };
  }
  return { ok: true, parentReceiptHash: null };
}

async function mirrorSnapshot(db: D1Database, entityType: 'venue' | 'food', entityId: string): Promise<string | null> {
  const row = await db.prepare('SELECT snapshot_id FROM catalog_mirror WHERE entity_type = ? AND entity_id = ?').bind(entityType, entityId).first<{ snapshot_id: string }>().catch(() => null);
  return row?.snapshot_id ?? null;
}

async function resolveSnapshot(db: D1Database, requested: string): Promise<string | null> {
  if (requested === 'catalog-v2' || requested === 'current') {
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
  return env.DB.prepare('SELECT id, schema_version, entity_type, entity_id, attached_review_id, status, version, upload_state, expected_images, expected_review_images, submitter_user_id, publication_mode, live_published_at FROM submissions WHERE id = ? AND receipt_hash = ?').bind(id, hash).first<SubmissionReceipt>();
}

type SubmissionReceipt = { id: string; schema_version: number; entity_type: string; entity_id: string; attached_review_id: string | null; status: string; version: number; upload_state: string; expected_images: number; expected_review_images: number; submitter_user_id: number | null; publication_mode: string; live_published_at: string | null };

function finalizedResponse(context: Context<AppEnv>, receipt: SubmissionReceipt, counts: { entity: number; attachedReview: number }, version: number, status: 'pending' | 'published') {
  return context.json({ submissionId: receipt.id, entityId: receipt.entity_id, status, uploadState: 'pending', publicationMode: receipt.publication_mode, version, uploadedImages: counts.entity, uploadedReviewImages: counts.attachedReview }, 200, { 'Cache-Control': 'no-store' });
}

function publicationFailure(cause: unknown) {
  const code = cause instanceof Error ? cause.message : '';
  return ['parent_venue_unpublished', 'review_target_unavailable', 'images_incomplete', 'media_object_missing', 'revision_conflict', 'entity_already_published', 'submission_owner_required', 'admin_session_expired'].includes(code) ? code : 'publication_failed';
}

async function publishDirect(env: AppEnv['Bindings'], id: string, version: number, actor: AuthSession, entityType: string) {
  const reviewer = entityType === 'venue' ? `auth:${actor.userId}:${actor.username}` : `user:${actor.userId}`;
  try { return await publishLive(env, id, version, reviewer, false, actor); }
  catch (cause) {
    const authority = entityType === 'venue' ? await adminSessionValid(env, actor).catch(() => undefined) : undefined;
    const code = authority === false ? 'admin_session_expired' : publicationFailure(cause), now = new Date().toISOString();
    await env.DB.batch([
      env.DB.prepare('UPDATE submissions SET live_error=? WHERE id=? AND version=? AND live_published_at IS NULL').bind(code, id, version),
      env.DB.prepare("INSERT INTO audit_events(id,submission_id,reviewer,action,version,reason,created_at) SELECT ?,?,?,'retry',?,?,? WHERE EXISTS (SELECT 1 FROM submissions WHERE id=? AND version=? AND live_published_at IS NULL)").bind(crypto.randomUUID(), id, reviewer, version, `direct_publish_failed:${code}`, now, id, version),
    ]).catch(() => undefined);
    if (code === 'admin_session_expired') throw new Error(code);
    throw cause;
  }
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
function adminRenewal(context: Context<AppEnv>) { return error(context, 'admin_session_expired', '管理员身份已到期或需要重新确认。资料与照片会保留，请在新标签页续权后继续。', 401); }
function error(context: Context<AppEnv>, code: string, message: string, status: 400 | 401 | 403 | 404 | 409 | 413 | 415 | 422 | 429 | 503, headers?: Record<string, string>, extra?: Record<string, unknown>) { return context.json({ ...(extra ?? {}), error: { code, message } }, status, { 'Cache-Control': 'no-store', ...(headers ?? {}) }); }
