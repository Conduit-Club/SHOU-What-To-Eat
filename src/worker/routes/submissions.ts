import { Hono } from 'hono';
import type { Context } from 'hono';
import { missingDatabaseConfig, missingSubmissionConfig, publicationEnabled } from '../config.js';
import { validateSubmission } from '../validation.js';
import { verifyTurnstile } from '../security.js';
import type { AppEnv } from '../types.js';

export const submissionRoutes = new Hono<AppEnv>();
submissionRoutes.post('/', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  if (missingSubmissionConfig(context.env).length) return unavailable(context);
  const ip = context.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipHash = await sha256(ip);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 3600) * 3600;
  const dupe = context.req.header('Idempotency-Key');
  if (dupe && !/^[A-Za-z0-9_-]{16,100}$/.test(dupe)) return context.json({ error: { code: 'invalid_idempotency_key', message: '重复提交标识无效。' } }, 400);
  const declaredLength = Number(context.req.header('Content-Length') ?? 0);
  if (declaredLength > MAX_REQUEST_BYTES) return context.json({ error: { code: 'request_too_large', message: '请求体超过限制。' } }, 413, { 'Cache-Control': 'no-store' });
  const body = await readBodyLimited(context.req.raw, MAX_REQUEST_BYTES);
  if (body.tooLarge) return context.json({ error: { code: 'request_too_large', message: '请求体超过限制。' } }, 413, { 'Cache-Control': 'no-store' });
  const payload = body.raw === null ? null : parseJson(body.raw);
  if (!payload) return context.json({ error: { code: 'invalid_json', message: '请求格式无效。' } }, 400, { 'Cache-Control': 'no-store' });
  let submission;
  try { submission = validateSubmission(payload); } catch (error) { return context.json({ error: { code: error instanceof Error ? error.message : 'invalid_submission', message: '投稿内容无效或超过限制。' } }, 422); }
  const originalJson = JSON.stringify(submission.publicFields);
  const requestHash = await sha256(JSON.stringify({ type: submission.type, targetRestaurantId: submission.targetRestaurantId, fields: submission.publicFields }));
  const keyHash = dupe ? await sha256(`${ipHash}:${dupe}`) : null;
  if (keyHash) {
    try {
      const existing = await context.env.DB.prepare('SELECT submission_id, request_hash FROM submission_idempotency WHERE key_hash = ?').bind(keyHash).first<{ submission_id: string; request_hash: string }>();
      if (existing) return replayOrConflict(context, existing, requestHash);
    } catch {
      return unavailable(context);
    }
  }
  if (!await verifyTurnstile(payload.turnstileToken, context.env.TURNSTILE_SECRET_KEY, ip)) return context.json({ error: { code: 'challenge_failed', message: '请完成人机验证后重试。' } }, 400);
  const id = crypto.randomUUID(); const receiptToken = crypto.randomUUID(); const receiptHash = await sha256(receiptToken); const createdAt = new Date().toISOString();
  try {
    const used = await context.env.DB.prepare('SELECT request_count FROM rate_limits WHERE key_hash = ? AND window_start = ?').bind(ipHash, windowStart).first<{ request_count: number }>();
    if ((used?.request_count ?? 0) >= 5) return context.json({ error: { code: 'rate_limited', message: '提交较为频繁，请稍后重试。' } }, 429, { 'Retry-After': String(windowStart + 3600 - now), 'Cache-Control': 'no-store' });
    await context.env.DB.batch([
      context.env.DB.prepare('INSERT INTO submissions (id, type, target_restaurant_id, original_json, revision_json, receipt_hash, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', 1, ?, ?)').bind(id, submission.type, submission.targetRestaurantId, originalJson, originalJson, receiptHash, createdAt, createdAt),
      ...(keyHash ? [context.env.DB.prepare('INSERT INTO submission_idempotency (key_hash, submission_id, request_hash, created_at) VALUES (?, ?, ?, ?)').bind(keyHash, id, requestHash, createdAt)] : []),
      context.env.DB.prepare('INSERT INTO rate_limits (key_hash, window_start, request_count) VALUES (?, ?, 1) ON CONFLICT (key_hash, window_start) DO UPDATE SET request_count = request_count + 1').bind(ipHash, windowStart),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'submit', 1, NULL, ?)").bind(crypto.randomUUID(), id, createdAt),
    ]);
    return context.json({ id, status: 'pending', receiptToken }, 202, { 'Cache-Control': 'no-store' });
  } catch {
    if (keyHash) {
      try {
        const existing = await context.env.DB.prepare('SELECT submission_id, request_hash FROM submission_idempotency WHERE key_hash = ?').bind(keyHash).first<{ submission_id: string; request_hash: string }>();
        if (existing) return replayOrConflict(context, existing, requestHash);
      } catch { /* Preserve the generic 503 below without exposing database details. */ }
    }
    return unavailable(context);
  }
});
submissionRoutes.get('/:id/status', async (context) => {
  if (!publicationEnabled(context.env)) return unavailable(context);
  if (missingDatabaseConfig(context.env).length) return unavailable(context);
  const token = context.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const hash = await sha256(token);
  const record = await context.env.DB.prepare('SELECT id, status, created_at, updated_at, receipt_hash FROM submissions WHERE id = ? AND receipt_hash = ?').bind(context.req.param('id'), hash).first<{ id: string; status: string; created_at: string; updated_at: string }>();
  return record ? context.json({ id: record.id, status: record.status, createdAt: record.created_at, updatedAt: record.updated_at }, 200, { 'Cache-Control': 'no-store' }) : context.json({ error: { code: 'not_found', message: '没有找到该投稿。' } }, 404, { 'Cache-Control': 'no-store' });
});

const MAX_REQUEST_BYTES = 64 * 1024;

async function readBodyLimited(request: Request, maxBytes: number): Promise<{ raw: string | null; tooLarge: boolean }> {
  if (!request.body) return { raw: '', tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { raw: null, tooLarge: true };
      }
      chunks.push(next.value);
    }
  } catch {
    return { raw: null, tooLarge: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { raw: new TextDecoder().decode(bytes), tooLarge: false };
}

function parseJson(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

function replayOrConflict(context: Context<AppEnv>, existing: { submission_id: string; request_hash: string }, requestHash: string) {
  if (existing.request_hash !== requestHash) return context.json({ error: { code: 'idempotency_conflict', message: '重复提交标识已用于另一份稿件。' } }, 409, { 'Cache-Control': 'no-store' });
  return context.json({ error: { code: 'idempotency_replayed', message: '该重复提交标识已经使用，请使用首次响应中的回执令牌查询状态。' }, id: existing.submission_id }, 409, { 'Cache-Control': 'no-store' });
}

function unavailable(context: Context<AppEnv>) { return context.json({ error: { code: 'service_unavailable', message: '投稿服务暂未配置完成，请稍后重试。' } }, 503, { 'Cache-Control': 'no-store' }); }

export async function sha256(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
