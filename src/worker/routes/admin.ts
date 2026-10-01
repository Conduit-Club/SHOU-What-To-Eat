import { Hono } from 'hono';
import { requireAccess } from '../security.js';
import type { AppEnv } from '../types.js';

export const adminRoutes = new Hono<AppEnv>();
adminRoutes.use('/*', requireAccess);
adminRoutes.get('/submissions', async (context) => {
  const status = context.req.query('status') ?? 'pending';
  const limit = Math.min(Math.max(Number(context.req.query('limit') ?? 30), 1), 100);
  const cursor = context.req.query('cursor') ?? '';
  if (!['pending', 'approved', 'rejected', 'exporting', 'export_failed', 'merged_dev', 'merged_main', 'deployed'].includes(status)) return context.json({ error: { code: 'invalid_status', message: '状态筛选无效。' } }, 400);
  const result = await context.env.DB.prepare('SELECT id, type, target_restaurant_id, original_json, revision_json, status, version, created_at, updated_at FROM submissions WHERE status = ? AND id > ? ORDER BY id LIMIT ?').bind(status, cursor, limit + 1).all();
  const rows = result.results.slice(0, limit);
  return context.json({ submissions: rows, nextCursor: result.results.length > limit ? rows.at(-1)?.id : null }, 200, { 'Cache-Control': 'no-store' });
});

adminRoutes.patch('/submissions/:id', async (context) => {
  if (context.req.header('Origin') && context.req.header('Origin') !== new URL(context.req.url).origin) return context.json({ error: { code: 'origin_forbidden', message: '请求来源不允许。' } }, 403);
  const body = await context.req.json().catch(() => null) as { expectedVersion?: unknown; revision?: unknown } | null;
  if (!body || !Number.isSafeInteger(body.expectedVersion) || !isObject(body.revision) || !validRevision(body.revision)) return context.json({ error: { code: 'invalid_revision', message: '审核稿或版本号无效。' } }, 422);
  const updatedAt = new Date().toISOString(); const revisionJson = JSON.stringify(body.revision); const auditId = crypto.randomUUID();
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE submissions SET revision_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ? AND status = 'pending'").bind(revisionJson, updatedAt, context.req.param('id'), body.expectedVersion),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, created_at) SELECT ?, id, ?, 'edit', version, ? FROM submissions WHERE id = ? AND version = ? AND status = 'pending'").bind(auditId, context.get('reviewer'), updatedAt, context.req.param('id'), Number(body.expectedVersion) + 1),
    ]);
    if (!results[0].meta.changes) return context.json({ error: { code: 'revision_conflict', message: '稿件已被另一位审核员修改，请刷新后重试。' } }, 409);
    const row = await context.env.DB.prepare('SELECT id, revision_json, version, updated_at FROM submissions WHERE id = ?').bind(context.req.param('id')).first();
    return context.json({ submission: row }, 200, { 'Cache-Control': 'no-store' });
  } catch { return context.json({ error: { code: 'review_unavailable', message: '审核修改没有保存。' } }, 503); }
});

adminRoutes.post('/submissions/:id/review', async (context) => {
  if (context.req.header('Origin') && context.req.header('Origin') !== new URL(context.req.url).origin) return context.json({ error: { code: 'origin_forbidden', message: '请求来源不允许。' } }, 403);
  const body = await context.req.json().catch(() => null) as { action?: unknown; expectedVersion?: unknown; reason?: unknown } | null;
  if (!body || !['approve', 'reject'].includes(String(body.action)) || !Number.isSafeInteger(body.expectedVersion) || body.action === 'reject' && (typeof body.reason !== 'string' || !body.reason.trim())) return context.json({ error: { code: 'invalid_review', message: '审核操作、版本或拒绝理由无效。' } }, 422);
  const id = context.req.param('id'); const reviewer = context.get('reviewer'); const now = new Date().toISOString(); const action = body.action as 'approve' | 'reject'; const auditId = crypto.randomUUID();
  const current = await context.env.DB.prepare("SELECT revision_json FROM submissions WHERE id = ? AND status = 'pending' AND version = ?").bind(id, body.expectedVersion).first<{ revision_json: string }>();
  if (!current) return context.json({ error: { code: 'revision_conflict', message: '稿件已更新或不在待审状态。' } }, 409);
  let revision: Record<string, unknown>;
  try { revision = JSON.parse(current.revision_json); } catch { return context.json({ error: { code: 'invalid_stored_revision', message: '稿件格式无效。' } }, 422); }
  if (action === 'approve' && (!validRevision(revision) || !safeMarkdown(String(revision.body ?? '')))) return context.json({ error: { code: 'unsafe_public_content', message: '审核稿缺少必要内容或包含不支持的 Markdown。' } }, 422);
  const status = action === 'approve' ? 'exporting' : 'rejected'; const reason = action === 'reject' ? String(body.reason).trim().slice(0, 500) : null;
  const jobId = crypto.randomUUID(); const jobBranch = `submission/${id.toLowerCase()}`; const contentHash = await hash(current.revision_json);
  try {
    const results = await context.env.DB.batch([
      context.env.DB.prepare("UPDATE submissions SET status = ?, reviewer = ?, reviewed_at = ?, updated_at = ?, version = version + 1, rejection_reason = ? WHERE id = ? AND status = 'pending' AND version = ?").bind(status, reviewer, now, now, reason, id, body.expectedVersion),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) SELECT ?, id, ?, ?, version, ?, ? FROM submissions WHERE id = ? AND status = ? AND version = ?").bind(auditId, reviewer, action, reason, now, id, status, Number(body.expectedVersion) + 1),
      ...(action === 'approve' ? [context.env.DB.prepare("INSERT INTO publication_jobs (id, submission_id, submission_version, content_hash, status, branch, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?)").bind(jobId, id, Number(body.expectedVersion) + 1, contentHash, jobBranch, now, now)] : []),
    ]);
    if (!results[0].meta.changes) return context.json({ error: { code: 'revision_conflict', message: '稿件已更新或不在待审状态。' } }, 409);
    return context.json({ id, status, publicationJobId: action === 'approve' ? jobId : null }, 200, { 'Cache-Control': 'no-store' });
  } catch { return context.json({ error: { code: 'review_unavailable', message: '审核操作没有保存。' } }, 503); }
});

adminRoutes.get('/publications', async (context) => {
  const result = await context.env.DB.prepare('SELECT id, submission_id, submission_version, status, branch, pr_number, pr_url, attempts, error_code, created_at, updated_at FROM publication_jobs ORDER BY updated_at DESC LIMIT 100').all();
  return context.json({ publications: result.results }, 200, { 'Cache-Control': 'no-store' });
});
adminRoutes.get('/submissions/:id', async (context) => {
  const submission = await context.env.DB.prepare('SELECT id, type, target_restaurant_id, original_json, revision_json, status, version, created_at, updated_at, reviewed_at, reviewer, rejection_reason FROM submissions WHERE id = ?').bind(context.req.param('id')).first();
  if (!submission) return context.json({ error: { code: 'not_found', message: '没有找到这条投稿。' } }, 404);
  const audits = await context.env.DB.prepare('SELECT reviewer, action, version, reason, created_at FROM audit_events WHERE submission_id = ? ORDER BY created_at').bind(context.req.param('id')).all();
  return context.json({ submission, audits: audits.results }, 200, { 'Cache-Control': 'no-store' });
});
adminRoutes.post('/publications/:id/retry', async (context) => {
  const now = new Date().toISOString();
  const result = await context.env.DB.batch([
    context.env.DB.prepare("UPDATE publication_jobs SET status = 'queued', error_code = NULL, lease_until = NULL, updated_at = ? WHERE id = ? AND status IN ('failed', 'closed')").bind(now, context.req.param('id')),
    context.env.DB.prepare("UPDATE submissions SET status = 'exporting', updated_at = ? WHERE id = (SELECT submission_id FROM publication_jobs WHERE id = ? AND status = 'queued') AND status = 'export_failed'").bind(now, context.req.param('id')),
    context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, created_at) SELECT ?, submission_id, ?, 'retry', submission_version, ? FROM publication_jobs WHERE id = ? AND status = 'queued'").bind(crypto.randomUUID(), context.get('reviewer'), now, context.req.param('id')),
  ]);
  if (!result[0].meta.changes) return context.json({ error: { code: 'not_retryable', message: '该发布任务不存在或不能重试。' } }, 409);
  return context.json({ id: context.req.param('id'), status: 'queued' }, 202);
});

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function validRevision(value: Record<string, unknown>) { return typeof value.name === 'string' && value.name.trim().length > 0 && value.name.length <= 100 && typeof value.location === 'string' && value.location.trim().length > 0 && value.location.length <= 300 && typeof value.body === 'string' && value.body.trim().length > 0 && value.body.length <= 20_000 && ['on-campus', 'off-campus'].includes(String(value.category)); }
function safeMarkdown(value: string) { return !/<\s*\/?\s*(script|iframe|object|embed|style|svg|math|img|video|audio|form)\b/i.test(value) && !/!\[[^\]]*\]\s*\(\s*(?!https:\/\/)[^)]+\)/i.test(value) && !/\]\(\s*(?:javascript|data|file|vbscript):/i.test(value); }
async function hash(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
