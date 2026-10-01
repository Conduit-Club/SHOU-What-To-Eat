import { Hono } from 'hono';
import type { Context } from 'hono';
import { requireAccess } from '../security.js';
import { publicationEnabled } from '../config.js';
import { sha256 } from './submissions.js';
import { privateMediaResponse } from '../media.js';
import { validateV2Revision, V2ValidationError, type V2EntityType } from '../v2-validation.js';
import type { AppEnv } from '../types.js';

export const adminV2Routes = new Hono<AppEnv>();
adminV2Routes.use('/*', requireAccess);

adminV2Routes.get('/submissions', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const status = context.req.query('status') ?? 'pending';
  const allowed = ['pending', 'approved', 'rejected', 'exporting', 'export_failed', 'merged_dev', 'merged_main', 'deployed'];
  if (!allowed.includes(status)) return fail(context, 'invalid_status', '状态筛选无效。', 400);
  const limit = Math.min(Math.max(Number(context.req.query('limit') ?? 30), 1), 100);
  const cursor = context.req.query('cursor') ?? '';
  const result = await context.env.DB.prepare("SELECT id, entity_type, entity_id, status, version, upload_state, expected_images, expected_review_images, snapshot_id, created_at, updated_at, reviewed_at, reviewer, rejection_reason FROM submissions WHERE schema_version = 2 AND status = ? AND id > ? ORDER BY id LIMIT ?").bind(status, cursor, limit + 1).all();
  const rows = result.results.slice(0, limit);
  return context.json({ submissions: rows, nextCursor: result.results.length > limit ? rows.at(-1)?.id ?? null : null }, 200, { 'Cache-Control': 'no-store' });
});

adminV2Routes.get('/publications', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const result = await context.env.DB.prepare("SELECT jobs.id, jobs.submission_id, jobs.submission_version, jobs.status, jobs.branch, jobs.pr_number, jobs.pr_url, jobs.attempts, jobs.error_code, jobs.created_at, jobs.updated_at FROM publication_jobs AS jobs INNER JOIN submissions AS submissions ON submissions.id = jobs.submission_id AND submissions.schema_version = 2 ORDER BY jobs.updated_at DESC LIMIT 100").all();
  return context.json({ publications: result.results }, 200, { 'Cache-Control': 'no-store' });
});

adminV2Routes.get('/submissions/:id', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const id = context.req.param('id');
  const submission = await context.env.DB.prepare("SELECT id, entity_type, entity_id, status, version, upload_state, expected_images, expected_review_images, snapshot_id, original_json, revision_json, created_at, updated_at, reviewed_at, reviewer, rejection_reason FROM submissions WHERE id = ? AND schema_version = 2").bind(id).first<Record<string, unknown>>();
  if (!submission) return fail(context, 'not_found', '没有找到这条投稿。', 404);
  const media = await context.env.DB.prepare('SELECT id, entity_type, entity_id, slot, slot_index, byte_size, width, height, alt, source, source_note, copyright_holder, license, rights_confirmed, is_illustrative, object_state, created_at, published_at FROM media_assets WHERE submission_id = ? ORDER BY slot, slot_index').bind(id).all();
  const audits = await context.env.DB.prepare('SELECT reviewer, action, version, reason, created_at FROM audit_events WHERE submission_id = ? ORDER BY created_at').bind(id).all();
  return context.json({ submission, media: media.results, audits: audits.results }, 200, { 'Cache-Control': 'no-store' });
});

adminV2Routes.get('/submissions/:id/images/:assetId', async (context) => {
  if (!publicationEnabled(context.env) || !context.env.IMAGES) return unavailable(context, 'media_storage_unavailable', '图片存储尚未配置完成，请稍后重试。');
  const asset = await context.env.DB.prepare("SELECT object_key, object_state FROM media_assets WHERE id = ? AND submission_id = ? AND object_state IN ('private', 'published')").bind(context.req.param('assetId'), context.req.param('id')).first<{ object_key: string; object_state: string }>();
  if (!asset) return fail(context, 'not_found', '没有找到这张图片。', 404);
  return privateMediaResponse(context.env, asset.object_key);
});

adminV2Routes.patch('/submissions/:id', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  if (crossOrigin(context)) return fail(context, 'origin_forbidden', '请求来源不允许。', 403);
  const body = await context.req.json().catch(() => null) as { expectedVersion?: unknown; revision?: unknown } | null;
  if (!body || !Number.isSafeInteger(body.expectedVersion) || !body.revision || typeof body.revision !== 'object') return fail(context, 'invalid_revision', '审核稿或版本号无效。', 422);
  const id = context.req.param('id');
  const current = await context.env.DB.prepare("SELECT entity_type, entity_id, attached_review_id, snapshot_id, expected_images, expected_review_images, upload_state, status, version FROM submissions WHERE id = ? AND schema_version = 2").bind(id).first<{ entity_type: V2EntityType; entity_id: string; attached_review_id: string | null; snapshot_id: string; expected_images: number; expected_review_images: number; upload_state: string; status: string; version: number }>();
  if (!current || current.status !== 'pending' || current.upload_state !== 'pending' || current.version !== body.expectedVersion) return fail(context, 'revision_conflict', '稿件已更新、图片未完成或不在待审状态。', 409);
  let revision;
  try { revision = validateV2Revision(body.revision, { entityType: current.entity_type, snapshotId: current.snapshot_id, expectedImages: current.expected_images, expectedReviewImages: current.expected_review_images }); } catch (cause) { return fail(context, cause instanceof V2ValidationError ? cause.code : 'invalid_revision', '审核稿内容无效。', 422); }
  if (revision.expectedImages !== current.expected_images || revision.expectedReviewImages !== current.expected_review_images) return fail(context, 'image_count_immutable', '审核编辑不能改变已声明的图片数量。', 409);
  const revisionJson = JSON.stringify(revision.publicJson);
  const revisionHash = await sha256(revisionJson);
  const now = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const nextAttachedReviewId = revision.attachedReview ? (current.attached_review_id ?? crypto.randomUUID()) : null;
  const statements = [
    context.env.DB.prepare("UPDATE submissions SET revision_json = ?, attached_review_id = ?, write_operation_id = ?, version = version + 1, updated_at = ? WHERE id = ? AND schema_version = 2 AND status = 'pending' AND upload_state = 'pending' AND version = ?").bind(revisionJson, nextAttachedReviewId, operationId, now, id, body.expectedVersion),
    context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) SELECT ?, id, ?, 'edit', version, 'v2_revision', ? FROM submissions WHERE id = ? AND schema_version = 2 AND status = 'pending' AND version = ? AND write_operation_id = ?").bind(crypto.randomUUID(), context.get('reviewer'), now, id, Number(body.expectedVersion) + 1, operationId),
  ];
  if (revision.attachedReview) {
    if (current.attached_review_id) {
      statements.push(context.env.DB.prepare("UPDATE reviews SET rating = ?, text = ?, content_hash = ?, updated_at = ? WHERE id = ? AND submission_id = ? AND publication_state = 'pending' AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND version = ? AND status = 'pending' AND write_operation_id = ?)").bind(revision.attachedReview.rating, revision.attachedReview.text, revisionHash, now, current.attached_review_id, id, id, Number(body.expectedVersion) + 1, operationId));
    } else {
      const targetType = current.entity_type === 'food' ? 'food' : 'venue';
      statements.push(context.env.DB.prepare("INSERT INTO reviews (id, submission_id, target_type, target_id, rating, text, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at) SELECT ?, ?, ?, ?, ?, ?, 2, 'pending', ?, ?, ?, ? FROM submissions WHERE id = ? AND version = ? AND status = 'pending' AND write_operation_id = ?").bind(nextAttachedReviewId, id, targetType, current.entity_id, revision.attachedReview.rating, revision.attachedReview.text, current.snapshot_id, revisionHash, now, now, id, Number(body.expectedVersion) + 1, operationId));
    }
  } else if (current.attached_review_id) {
    statements.push(context.env.DB.prepare("UPDATE reviews SET publication_state = 'archived', updated_at = ? WHERE id = ? AND submission_id = ? AND publication_state = 'pending' AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND version = ? AND status = 'pending' AND write_operation_id = ?)").bind(now, current.attached_review_id, id, id, Number(body.expectedVersion) + 1, operationId));
  }
  const result = await context.env.DB.batch(statements).catch(() => null);
  // D1 batches are atomic, but a conditional child UPDATE/INSERT can still
  // report zero changes without throwing. Treat that as a CAS failure too;
  // otherwise the parent revision could advance while its attached review
  // stayed stale and the next export would publish mixed values.
  if (!result || result.length !== statements.length || result.some((entry) => !entry?.meta?.changes)) return fail(context, 'revision_conflict', '稿件已被另一位审核员修改，请刷新后重试。', 409);
  return context.json({ submissionId: id, version: Number(body.expectedVersion) + 1, revision: revision.publicJson }, 200, { 'Cache-Control': 'no-store' });
});

adminV2Routes.post('/submissions/:id/review', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  if (crossOrigin(context)) return fail(context, 'origin_forbidden', '请求来源不允许。', 403);
  const body = await context.req.json().catch(() => null) as { action?: unknown; expectedVersion?: unknown; reason?: unknown } | null;
  const action = body?.action === 'approve' || body?.action === 'reject' ? body.action : null;
  if (!body || !action || !Number.isSafeInteger(body.expectedVersion) || action === 'reject' && (typeof body.reason !== 'string' || !body.reason.trim())) return fail(context, 'invalid_review', '审核操作、版本或拒绝理由无效。', 422);
  const id = context.req.param('id');
  const current = await context.env.DB.prepare("SELECT id, entity_type, entity_id, status, version, upload_state, expected_images, expected_review_images, snapshot_id, revision_json, parent_entity_id FROM submissions WHERE id = ? AND schema_version = 2 AND status = 'pending' AND version = ?").bind(id, body.expectedVersion).first<{ id: string; entity_type: V2EntityType; entity_id: string; status: string; version: number; upload_state: string; expected_images: number; expected_review_images: number; snapshot_id: string; revision_json: string; parent_entity_id: string | null }>();
  if (!current) return fail(context, 'revision_conflict', '稿件已更新或不在待审状态。', 409);
  let privateMediaCount = 0;
  if (action === 'approve') {
    const counts = await context.env.DB.prepare("SELECT slot, COUNT(*) AS count FROM media_assets WHERE submission_id = ? AND object_state = 'private' GROUP BY slot").bind(id).all<{ slot: string; count: number }>();
    const entityCount = Number(counts.results.find((row) => row.slot === 'entity')?.count ?? 0);
    const reviewCount = Number(counts.results.find((row) => row.slot === 'attachedReview')?.count ?? 0);
    privateMediaCount = entityCount + reviewCount;
    if (current.upload_state !== 'pending' || entityCount !== current.expected_images || reviewCount !== current.expected_review_images) return fail(context, 'images_incomplete', '图片尚未完成或状态不允许审核。', 409);
    const parentCheck = await publishedParent(context, current);
    if (!parentCheck.ok) return fail(context, parentCheck.code, parentCheck.message, 409);
    try {
      const parsed = JSON.parse(current.revision_json) as Record<string, unknown>;
      validateV2Revision(parsed, { entityType: current.entity_type, snapshotId: current.snapshot_id, expectedImages: current.expected_images, expectedReviewImages: current.expected_review_images });
    } catch (cause) { return fail(context, cause instanceof V2ValidationError ? cause.code : 'invalid_stored_revision', '存储的审核稿无法发布。', 422); }
  }
  const now = new Date().toISOString();
  const nextStatus = action === 'approve' ? 'exporting' : 'rejected';
  const contentHash = await sha256(current.revision_json);
  const jobId = crypto.randomUUID();
  const operationId = crypto.randomUUID();
  const branch = `submission/${id.toLowerCase()}`;
  const reason = action === 'reject' ? String(body.reason).trim().slice(0, 500) : null;
  try {
    const statements = [
      context.env.DB.prepare("UPDATE submissions SET status = ?, reviewer = ?, reviewed_at = ?, updated_at = ?, write_operation_id = ?, version = version + 1, rejection_reason = ? WHERE id = ? AND schema_version = 2 AND status = 'pending' AND version = ?").bind(nextStatus, context.get('reviewer'), now, now, operationId, reason, id, body.expectedVersion),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) SELECT ?, id, ?, ?, version, ?, ? FROM submissions WHERE id = ? AND schema_version = 2 AND status = ? AND version = ? AND write_operation_id = ?").bind(crypto.randomUUID(), context.get('reviewer'), action, reason, now, id, nextStatus, Number(body.expectedVersion) + 1, operationId),
    ];
    if (action === 'approve') {
      if (privateMediaCount > 0) statements.push(context.env.DB.prepare("UPDATE media_assets SET permission = 'approved' WHERE submission_id = ? AND object_state = 'private' AND rights_confirmed = 1 AND EXISTS (SELECT 1 FROM submissions WHERE id = ? AND schema_version = 2 AND status = 'exporting' AND version = ? AND write_operation_id = ?)").bind(id, id, Number(body.expectedVersion) + 1, operationId));
      statements.push(context.env.DB.prepare("INSERT INTO publication_jobs (id, submission_id, submission_version, content_hash, status, branch, attempts, created_at, updated_at) SELECT ?, id, ?, ?, 'queued', ?, 0, ?, ? FROM submissions WHERE id = ? AND schema_version = 2 AND status = 'exporting' AND version = ? AND write_operation_id = ?").bind(jobId, Number(body.expectedVersion) + 1, contentHash, branch, now, now, id, Number(body.expectedVersion) + 1, operationId));
    }
    const result = await context.env.DB.batch(statements);
    if (result.length !== statements.length || result.some((entry) => !entry?.meta?.changes)) return fail(context, 'revision_conflict', '稿件已被另一位审核员处理。', 409);
  } catch { return unavailable(context, 'review_unavailable', '审核操作没有保存。'); }
  return context.json({ submissionId: id, status: nextStatus, publicationJobId: action === 'approve' ? jobId : null }, 200, { 'Cache-Control': 'no-store' });
});

adminV2Routes.post('/publications/:id/retry', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  const id = context.req.param('id'); const now = new Date().toISOString();
  const result = await context.env.DB.batch([
    context.env.DB.prepare("UPDATE publication_jobs SET status = 'queued', error_code = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'closed')").bind(now, id),
    context.env.DB.prepare("UPDATE submissions SET status = 'exporting', updated_at = ? WHERE id = (SELECT submission_id FROM publication_jobs WHERE id = ? AND status = 'queued') AND schema_version = 2 AND status = 'export_failed'").bind(now, id),
    context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) SELECT ?, submission_id, ?, 'retry', submission_version, 'v2_retry', ? FROM publication_jobs WHERE id = ? AND status = 'queued'").bind(crypto.randomUUID(), context.get('reviewer'), now, id),
  ]).catch(() => null);
  if (!result?.[0]?.meta?.changes) return fail(context, 'not_retryable', '该发布任务不存在或不能重试。', 409);
  return context.json({ publicationJobId: id, status: 'queued' }, 202, { 'Cache-Control': 'no-store' });
});

async function publishedParent(context: Context<AppEnv>, row: { entity_type: V2EntityType; entity_id: string; parent_entity_id: string | null; snapshot_id: string }) {
  if (row.entity_type === 'food') {
    const parent = await context.env.DB.prepare("SELECT publication_state FROM venues WHERE id = ?").bind(row.parent_entity_id).first<{ publication_state: string }>();
    if (!parent || parent.publication_state !== 'published') return { ok: false as const, code: 'parent_venue_unpublished', message: '父 venue 尚未发布。' };
  } else if (row.entity_type === 'review') {
    const value = await context.env.DB.prepare('SELECT target_type, target_id FROM reviews WHERE id = ?').bind(row.entity_id).first<{ target_type: string; target_id: string }>();
    if (!value) return { ok: false as const, code: 'review_target_unavailable', message: '评价目标不存在。' };
    const table = value.target_type === 'venue' ? 'venues' : 'foods';
    const target = await context.env.DB.prepare(`SELECT publication_state FROM ${table} WHERE id = ?`).bind(value.target_id).first<{ publication_state: string }>();
    if (!target || target.publication_state !== 'published') return { ok: false as const, code: 'review_target_unpublished', message: '评价目标尚未发布。' };
  }
  return { ok: true as const };
}

function crossOrigin(context: Context<AppEnv>) { const origin = context.req.header('Origin'); return Boolean(origin && origin !== new URL(context.req.url).origin); }
function unavailable(context: Context<AppEnv>, code = 'service_unavailable', message = '审核服务暂未配置完成，请稍后重试。') { return fail(context, code, message, 503); }
function fail(context: Context<AppEnv>, code: string, message: string, status: 400 | 403 | 404 | 409 | 422 | 503) { return context.json({ error: { code, message } }, status, { 'Cache-Control': 'no-store' }); }
