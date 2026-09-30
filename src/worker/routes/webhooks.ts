import { Hono } from 'hono';
import type { AppEnv } from '../types.js';

export const webhookRoutes = new Hono<AppEnv>();
webhookRoutes.post('/github', async (context) => {
  const raw = await context.req.text(); const signature = context.req.header('X-Hub-Signature-256') ?? ''; const delivery = context.req.header('X-GitHub-Delivery');
  if (!delivery || !/^sha256=[a-f0-9]{64}$/.test(signature) || !await verifySignature(raw, signature.slice(7), context.env.GITHUB_WEBHOOK_SECRET)) return context.json({ error: { code: 'invalid_webhook_signature', message: 'Webhook 签名无效。' } }, 401);
  try {
    const payload = JSON.parse(raw) as { action?: string; pull_request?: { number?: number; merged?: boolean; head?: { ref?: string }; base?: { ref?: string }; merge_commit_sha?: string }; repository?: { full_name?: string } };
    if (payload.repository?.full_name !== context.env.GITHUB_REPOSITORY) return context.json({ error: { code: 'wrong_repository', message: '仓库不匹配。' } }, 403);
    const inserted = await context.env.DB.prepare('INSERT INTO webhook_events (delivery_id, received_at) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(delivery, new Date().toISOString()).run();
    if (!inserted.meta.changes) return context.json({ received: true, duplicate: true });
    const pr = payload.pull_request;
    if (pr?.number && pr.head?.ref?.startsWith('submission/')) {
      const job = await context.env.DB.prepare('SELECT id, submission_id FROM publication_jobs WHERE branch = ?').bind(pr.head.ref).first<{ id: string; submission_id: string }>();
      if (job && ['opened', 'synchronize', 'closed'].includes(payload.action ?? '')) {
        const status = pr.merged ? 'merged_dev' : payload.action === 'closed' ? 'closed' : 'pr_open'; const now = new Date().toISOString();
        await context.env.DB.batch([context.env.DB.prepare('UPDATE publication_jobs SET status = ?, pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ?').bind(status, pr.number, `https://github.com/${context.env.GITHUB_REPOSITORY}/pull/${pr.number}`, now, job.id), ...(pr.merged ? [context.env.DB.prepare("UPDATE submissions SET status = 'merged_dev', updated_at = ? WHERE id = ?").bind(now, job.submission_id)] : [])]);
        if (pr.merged) await context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) SELECT ?, submission_id, 'github', 'publish', submission_version, ?, ? FROM publication_jobs WHERE id = ?").bind(crypto.randomUUID(), job.submission_id, pr.merge_commit_sha ?? null, now, job.id).run();
      }
    }
    if (pr?.merged && pr.head?.ref === 'dev' && pr.base?.ref === 'main') {
      const now = new Date().toISOString();
      await context.env.DB.batch([
        context.env.DB.prepare("UPDATE publication_jobs SET status = 'merged_main', updated_at = ? WHERE status = 'merged_dev'").bind(now),
        context.env.DB.prepare("UPDATE submissions SET status = 'merged_main', updated_at = ? WHERE status = 'merged_dev'").bind(now),
      ]);
    }
    return context.json({ received: true });
  } catch { return context.json({ error: { code: 'invalid_webhook', message: 'Webhook 负载无效。' } }, 400); }
});

webhookRoutes.post('/deploy', async (context) => {
  const raw = await context.req.text();
  const signature = context.req.header('X-Deploy-Signature') ?? '';
  if (!/^sha256=[a-f0-9]{64}$/.test(signature) || !await verifySignature(raw, signature.slice(7), context.env.DEPLOY_WEBHOOK_SECRET)) return context.json({ error: { code: 'invalid_deploy_signature', message: '部署回调签名无效。' } }, 401);
  const payload = JSON.parse(raw) as { commit?: unknown };
  if (typeof payload.commit !== 'string' || !/^[0-9a-f]{7,64}$/i.test(payload.commit)) return context.json({ error: { code: 'invalid_deploy_payload', message: '部署提交号无效。' } }, 422);
  const now = new Date().toISOString();
  await context.env.DB.batch([
    context.env.DB.prepare("UPDATE publication_jobs SET status = 'deployed', updated_at = ? WHERE status = 'merged_main'").bind(now),
    context.env.DB.prepare("UPDATE submissions SET status = 'deployed', updated_at = ? WHERE status = 'merged_main'").bind(now),
  ]);
  return context.json({ deployed: true, commit: payload.commit });
});
async function verifySignature(body: string, signature: string, secret: string) {
  if (!secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))); const actual = Uint8Array.from(signature.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  if (expected.length !== actual.length) return false; let result = 0; for (let index = 0; index < expected.length; index += 1) result |= expected[index] ^ actual[index]; return result === 0;
}
