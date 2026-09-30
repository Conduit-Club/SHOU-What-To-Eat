import { Hono } from 'hono';
import { validateSubmission } from '../validation.js';
import { verifyTurnstile } from '../security.js';
import type { AppEnv } from '../types.js';

export const submissionRoutes = new Hono<AppEnv>();
submissionRoutes.post('/', async (context) => {
  const ip = context.req.header('CF-Connecting-IP') ?? 'unknown';
  const ipHash = await sha256(ip);
  const now = Math.floor(Date.now() / 1000);
  const windowStart = Math.floor(now / 3600) * 3600;
  const dupe = context.req.header('Idempotency-Key');
  if (dupe && !/^[A-Za-z0-9_-]{16,100}$/.test(dupe)) return context.json({ error: { code: 'invalid_idempotency_key', message: '重复提交标识无效。' } }, 400);
  const used = await context.env.DB.prepare('SELECT request_count FROM rate_limits WHERE key_hash = ? AND window_start = ?').bind(ipHash, windowStart).first<{ request_count: number }>();
  if ((used?.request_count ?? 0) >= 5) return context.json({ error: { code: 'rate_limited', message: '提交较为频繁，请稍后重试。' } }, 429, { 'Retry-After': String(windowStart + 3600 - now) });
  const payload = await context.req.json().catch(() => null) as Record<string, unknown> | null;
  if (!payload || !await verifyTurnstile(payload.turnstileToken, context.env.TURNSTILE_SECRET_KEY, ip)) return context.json({ error: { code: 'challenge_failed', message: '请完成人机验证后重试。' } }, 400);
  let submission;
  try { submission = validateSubmission(payload); } catch (error) { return context.json({ error: { code: error instanceof Error ? error.message : 'invalid_submission', message: '投稿内容无效或超过限制。' } }, 422); }
  const id = crypto.randomUUID(); const receiptToken = crypto.randomUUID(); const receiptHash = await sha256(receiptToken); const createdAt = new Date().toISOString();
  const originalJson = JSON.stringify(submission.publicFields);
  try {
    await context.env.DB.batch([
      context.env.DB.prepare('INSERT INTO submissions (id, type, target_restaurant_id, original_json, revision_json, receipt_hash, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, \'pending\', 1, ?, ?)').bind(id, submission.type, submission.targetRestaurantId, originalJson, originalJson, receiptHash, createdAt, createdAt),
      context.env.DB.prepare('INSERT INTO rate_limits (key_hash, window_start, request_count) VALUES (?, ?, 1) ON CONFLICT (key_hash, window_start) DO UPDATE SET request_count = request_count + 1').bind(ipHash, windowStart),
    ]);
    return context.json({ id, status: 'pending', receiptToken }, 202, { 'Cache-Control': 'no-store' });
  } catch { return context.json({ error: { code: 'submission_unavailable', message: '暂时无法保存投稿，请稍后重试。' } }, 503); }
});
submissionRoutes.get('/:id/status', async (context) => {
  const token = context.req.header('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const hash = await sha256(token);
  const record = await context.env.DB.prepare('SELECT id, status, created_at, updated_at, receipt_hash FROM submissions WHERE id = ? AND receipt_hash = ?').bind(context.req.param('id'), hash).first<{ id: string; status: string; created_at: string; updated_at: string }>();
  return record ? context.json({ id: record.id, status: record.status, createdAt: record.created_at, updatedAt: record.updated_at }, 200, { 'Cache-Control': 'no-store' }) : context.json({ error: { code: 'not_found', message: '没有找到该投稿。' } }, 404, { 'Cache-Control': 'no-store' });
});
async function sha256(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
