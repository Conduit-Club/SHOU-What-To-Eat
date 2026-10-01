import { Hono } from 'hono';
import { publicationEnabled } from '../config.js';
import { publishMediaAssets, restorePrivateMedia } from '../media.js';
import type { AppEnv } from '../types.js';

export const webhookRoutes = new Hono<AppEnv>();
webhookRoutes.use('/*', async (context, next) => {
  if (!publicationEnabled(context.env)) return context.json({ error: { code: 'service_unavailable', message: '发布链尚未启用。' } }, 503, { 'Cache-Control': 'no-store' });
  await next();
});
webhookRoutes.post('/github', async (context) => {
  const raw = await context.req.text(); const signature = context.req.header('X-Hub-Signature-256') ?? ''; const delivery = context.req.header('X-GitHub-Delivery');
  if (!delivery || !/^sha256=[a-f0-9]{64}$/.test(signature) || !await verifySignature(raw, signature.slice(7), context.env.GITHUB_WEBHOOK_SECRET)) return context.json({ error: { code: 'invalid_webhook_signature', message: 'Webhook 签名无效。' } }, 401);
  if (context.req.header('X-GitHub-Event') !== 'pull_request') return context.json({ received: true, ignored: true }, 202, { 'Cache-Control': 'no-store' });
  let payload: { action?: string; pull_request?: { number?: number; merged?: boolean; head?: { ref?: string }; base?: { ref?: string }; merge_commit_sha?: string }; repository?: { full_name?: string } };
  try { payload = JSON.parse(raw) as typeof payload; } catch { return context.json({ error: { code: 'invalid_webhook', message: 'Webhook 负载无效。' } }, 400); }
  if (payload.repository?.full_name !== context.env.GITHUB_REPOSITORY) return context.json({ error: { code: 'wrong_repository', message: '仓库不匹配。' } }, 403);
  const claim = await claimDelivery(context.env.DB, delivery);
  if (claim === 'duplicate') return context.json({ received: true, duplicate: true }, 200, { 'Cache-Control': 'no-store' });
  if (claim === 'busy') return context.json({ received: true, processing: true }, 202, { 'Cache-Control': 'no-store' });
  try {
    const pr = payload.pull_request;
    if (pr?.number && pr.head?.ref?.startsWith('submission/') && pr.base?.ref === 'dev') {
      const job = await context.env.DB.prepare('SELECT id, submission_id, submission_version FROM publication_jobs WHERE branch = ?').bind(pr.head.ref).first<{ id: string; submission_id: string; submission_version: number }>();
      if (job && ['opened', 'reopened', 'synchronize', 'closed'].includes(payload.action ?? '')) {
        const now = new Date().toISOString();
        const prUrl = `https://github.com/${context.env.GITHUB_REPOSITORY}/pull/${pr.number}`;
        if (pr.merged) {
          // A merge advances a submission PR exactly once. Delayed opened,
          // synchronize, or closed payloads must not move it backwards.
          await context.env.DB.batch([
            context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) SELECT ?, submission_id, 'github', 'publish', submission_version, ?, ? FROM publication_jobs WHERE id = ? AND status IN ('queued', 'running', 'pr_open', 'closed')").bind(crypto.randomUUID(), pr.merge_commit_sha ?? null, now, job.id),
            context.env.DB.prepare("UPDATE submissions SET status = 'merged_dev', updated_at = ? WHERE id = ? AND status IN ('approved', 'exporting', 'export_failed', 'merged_dev') AND EXISTS (SELECT 1 FROM publication_jobs WHERE id = ? AND status IN ('queued', 'running', 'pr_open', 'closed'))").bind(now, job.submission_id, job.id),
            context.env.DB.prepare("UPDATE publication_jobs SET status = 'merged_dev', pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running', 'pr_open', 'closed')").bind(pr.number, prUrl, now, job.id),
          ]);
        } else if (payload.action === 'closed') {
          await context.env.DB.prepare("UPDATE publication_jobs SET status = 'closed', pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running', 'pr_open')").bind(pr.number, prUrl, now, job.id).run();
          await context.env.DB.prepare("UPDATE submissions SET status = 'export_failed', updated_at = ? WHERE id = ? AND status = 'exporting' AND EXISTS (SELECT 1 FROM publication_jobs WHERE id = ? AND status = 'closed')").bind(now,job.submission_id,job.id).run();
        } else {
          await context.env.DB.prepare("UPDATE submissions SET status = 'exporting', updated_at = ? WHERE id = ? AND status = 'export_failed' AND EXISTS (SELECT 1 FROM publication_jobs WHERE id = ? AND status = 'closed')").bind(now,job.submission_id,job.id).run();
          await context.env.DB.prepare("UPDATE publication_jobs SET status = 'pr_open', pr_number = ?, pr_url = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running', 'pr_open', 'closed')").bind(pr.number, prUrl, now, job.id).run();
        }
      }
    }
    if (pr?.merged && pr.head?.ref === 'dev' && pr.base?.ref === 'main') {
      const now = new Date().toISOString();
      await context.env.DB.batch([
        context.env.DB.prepare("UPDATE publication_jobs SET status = 'merged_main', main_commit_sha = ?, updated_at = ? WHERE status = 'merged_dev'").bind(pr.merge_commit_sha?.toLowerCase() ?? null, now),
        context.env.DB.prepare("UPDATE submissions SET status = 'merged_main', updated_at = ? WHERE status = 'merged_dev'").bind(now),
      ]);
    }
    await markDeliveryProcessed(context.env.DB, delivery);
    return context.json({ received: true });
  } catch {
    await markDeliveryFailed(context.env.DB, delivery).catch(() => undefined);
    return context.json({ error: { code: 'webhook_processing_failed', message: 'Webhook 尚未处理完成，请稍后重试。' } }, 503, { 'Cache-Control': 'no-store' });
  }
});

webhookRoutes.post('/deploy', async (context) => {
  const raw = await context.req.text();
  const signature = context.req.header('X-Deploy-Signature') ?? '';
  if (!/^sha256=[a-f0-9]{64}$/.test(signature) || !await verifySignature(raw, signature.slice(7), context.env.DEPLOY_WEBHOOK_SECRET)) return context.json({ error: { code: 'invalid_deploy_signature', message: '部署回调签名无效。' } }, 401);
  let payload: { repository?: unknown; commit?: unknown; contentHash?: unknown; jobId?: unknown };
  try { payload = JSON.parse(raw) as typeof payload; } catch { return context.json({ error: { code: 'invalid_deploy_payload', message: '部署回调负载无效。' } }, 422); }
  if (payload.repository !== context.env.GITHUB_REPOSITORY) return context.json({ error: { code: 'wrong_repository', message: '仓库不匹配。' } }, 403);
  if (typeof payload.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(payload.commit) || typeof payload.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(payload.contentHash) || typeof payload.jobId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(payload.jobId)) return context.json({ error: { code: 'invalid_deploy_payload', message: '部署提交号、内容哈希或任务号无效。' } }, 422);
  const repository = String(payload.repository);
  const commit = payload.commit.toLowerCase();
  const contentHash = payload.contentHash.toLowerCase();
  const jobId = payload.jobId;
  const job = await context.env.DB.prepare("SELECT publication_jobs.id AS id, publication_jobs.submission_id AS submission_id, publication_jobs.submission_version AS submission_version, publication_jobs.status AS status, submissions.entity_type AS entity_type, submissions.attached_review_id AS attached_review_id FROM publication_jobs JOIN submissions ON submissions.id = publication_jobs.submission_id WHERE publication_jobs.id = ? AND publication_jobs.status IN ('merged_main', 'deployed') AND publication_jobs.main_commit_sha = ? AND publication_jobs.content_hash = ?").bind(jobId, commit, contentHash).first<{ id: string; submission_id: string; submission_version: number; status: string; entity_type: string | null; attached_review_id: string | null }>();
  if (!job) return context.json({ error: { code: 'deployment_mismatch', message: '部署提交与待发布内容不匹配。' } }, 409, { 'Cache-Control': 'no-store' });
  if (job.status === 'deployed') return context.json({ received: true, duplicate: true }, 200, { 'Cache-Control': 'no-store' });
  const now = new Date().toISOString();
  const callbackClaim = await claimDeploymentCallback(context.env.DB, repository, commit, contentHash, jobId, now);
  if (callbackClaim === 'duplicate') return context.json({ received: true, duplicate: true }, 200, { 'Cache-Control': 'no-store' });
  if (callbackClaim === 'busy') return context.json({ received: true, processing: true }, 202, { 'Cache-Control': 'no-store' });
  let assetIds: string[] = [];
  try {
    const assets = await context.env.DB.prepare("SELECT id FROM media_assets WHERE submission_id = ? AND object_state = 'private' AND permission = 'approved'").bind(job.submission_id).all<{ id: string }>();
    assetIds = assets.results.map((asset) => asset.id);
    await publishMediaAssets(context.env, assetIds);
    const statements = [
      context.env.DB.prepare("UPDATE publication_jobs SET status = 'deployed', updated_at = ? WHERE id = ? AND status = 'merged_main' AND main_commit_sha = ? AND content_hash = ?").bind(now, job.id, commit, contentHash),
      context.env.DB.prepare("UPDATE submissions SET status = 'deployed', updated_at = ? WHERE id = ? AND status = 'merged_main'").bind(now, job.submission_id),
      context.env.DB.prepare("UPDATE venues SET publication_state = 'published', snapshot_id = (SELECT snapshot_id FROM catalog_mirror WHERE entity_type = 'venue' AND entity_id = venues.id), content_hash = (SELECT content_hash FROM catalog_mirror WHERE entity_type = 'venue' AND entity_id = venues.id), published_at = ?, updated_at = ? WHERE submission_id = ? AND schema_version = 2 AND EXISTS (SELECT 1 FROM catalog_mirror WHERE entity_type = 'venue' AND entity_id = venues.id)").bind(now, now, job.submission_id),
      context.env.DB.prepare("UPDATE foods SET publication_state = 'published', snapshot_id = (SELECT snapshot_id FROM catalog_mirror WHERE entity_type = 'food' AND entity_id = foods.id), content_hash = (SELECT content_hash FROM catalog_mirror WHERE entity_type = 'food' AND entity_id = foods.id), published_at = ?, updated_at = ? WHERE submission_id = ? AND schema_version = 2 AND EXISTS (SELECT 1 FROM catalog_mirror WHERE entity_type = 'food' AND entity_id = foods.id)").bind(now, now, job.submission_id),
    ];
    let normalizedIndex: number | null = job.entity_type === 'venue' ? 2 : job.entity_type === 'food' ? 3 : null;
    if (job.entity_type === 'review') {
      normalizedIndex = statements.length;
      statements.push(context.env.DB.prepare("UPDATE reviews SET publication_state = 'published', snapshot_id = (SELECT snapshot_id FROM catalog_mirror WHERE entity_type = 'review' AND entity_id = reviews.id), content_hash = (SELECT content_hash FROM catalog_mirror WHERE entity_type = 'review' AND entity_id = reviews.id), published_at = ?, updated_at = ? WHERE submission_id = ? AND schema_version = 2 AND EXISTS (SELECT 1 FROM catalog_mirror WHERE entity_type = 'review' AND entity_id = reviews.id)").bind(now, now, job.submission_id));
    }
    const attachedReviewIndex = job.attached_review_id && job.entity_type !== 'review' ? statements.length : null;
    if (attachedReviewIndex !== null) statements.push(context.env.DB.prepare("UPDATE reviews SET publication_state = 'published', snapshot_id = (SELECT snapshot_id FROM catalog_mirror WHERE entity_type = 'review' AND entity_id = reviews.id), content_hash = (SELECT content_hash FROM catalog_mirror WHERE entity_type = 'review' AND entity_id = reviews.id), published_at = ?, updated_at = ? WHERE id = ? AND submission_id = ? AND schema_version = 2 AND publication_state = 'pending' AND EXISTS (SELECT 1 FROM catalog_mirror WHERE entity_type = 'review' AND entity_id = reviews.id)").bind(now, now, job.attached_review_id, job.submission_id));
    const auditStatementIndex = statements.length;
    statements.push(context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'deploy', 'deploy_callback', ?, ?, ?)").bind(crypto.randomUUID(), job.submission_id, job.submission_version, `${commit}:${contentHash}`, now));
    const mediaStatementIndex = statements.length;
    if (assetIds.length) statements.push(context.env.DB.prepare("UPDATE media_assets SET object_state = 'published', published_at = ? WHERE submission_id = ? AND object_state = 'private' AND permission = 'approved'").bind(now, job.submission_id));
    const result = await context.env.DB.batch(statements);
    if (!result?.[0]?.meta?.changes || !result?.[1]?.meta?.changes || normalizedIndex !== null && !result?.[normalizedIndex]?.meta?.changes || attachedReviewIndex !== null && !result?.[attachedReviewIndex]?.meta?.changes || !result?.[auditStatementIndex]?.meta?.changes || assetIds.length && result?.[mediaStatementIndex]?.meta?.changes !== assetIds.length) throw new Error('deployment_state_conflict');
    // The publication transaction above is the source of truth. A transient
    // marker update must not roll it back or make already-public media private;
    // a later callback sees the deployed job and safely answers duplicate.
    await context.env.DB.prepare("UPDATE deployment_callbacks SET status = 'completed', processed_at = ? WHERE repository = ? AND commit_sha = ? AND content_hash = ? AND job_id = ? AND status = 'processing'").bind(now, repository, commit, contentHash, jobId).run().catch(() => undefined);
  } catch {
    await restorePrivateMedia(context.env, assetIds).catch(() => undefined);
    await context.env.DB.batch([
      context.env.DB.prepare('DELETE FROM deployment_callbacks WHERE repository = ? AND commit_sha = ? AND content_hash = ? AND job_id = ?').bind(repository, commit, contentHash, jobId),
      context.env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'deploy', 'retry', ?, 'deployment_publish_failed', ?)").bind(crypto.randomUUID(), job.submission_id, job.submission_version, now),
    ]).catch(() => undefined);
    return context.json({ error: { code: 'deployment_publish_failed', message: '部署回调已接收，但公开内容尚未完成。' } }, 503, { 'Cache-Control': 'no-store' });
  }
  return context.json({ deployed: true, jobId, commit, contentHash }, 200, { 'Cache-Control': 'no-store' });
});

async function claimDelivery(db: D1Database, delivery: string): Promise<'claimed' | 'duplicate' | 'busy'> {
  const now = new Date().toISOString();
  const inserted = await db.prepare("INSERT INTO webhook_events (delivery_id, received_at, status, attempts) VALUES (?, ?, 'processing', 1) ON CONFLICT DO NOTHING").bind(delivery, now).run();
  if (inserted.meta.changes) return 'claimed';
  const existing = await db.prepare('SELECT status, received_at FROM webhook_events WHERE delivery_id = ?').bind(delivery).first<{ status: string; received_at: string }>();
  if (!existing || existing.status === 'processed') return 'duplicate';
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const reclaimed = await db.prepare("UPDATE webhook_events SET status = 'processing', received_at = ?, attempts = attempts + 1, processed_at = NULL WHERE delivery_id = ? AND (status = 'failed' OR (status = 'processing' AND received_at < ?))").bind(now, delivery, staleBefore).run();
  return reclaimed.meta.changes ? 'claimed' : 'busy';
}

async function claimDeploymentCallback(db: D1Database, repository: string, commit: string, contentHash: string, jobId: string, now: string): Promise<'claimed' | 'duplicate' | 'busy'> {
  const inserted = await db.prepare("INSERT INTO deployment_callbacks (repository, commit_sha, content_hash, job_id, received_at, status, attempts) VALUES (?, ?, ?, ?, ?, 'processing', 1) ON CONFLICT DO NOTHING").bind(repository, commit, contentHash, jobId, now).run();
  if (inserted.meta.changes) return 'claimed';
  const existing = await db.prepare('SELECT status, received_at FROM deployment_callbacks WHERE repository = ? AND commit_sha = ? AND content_hash = ? AND job_id = ?').bind(repository, commit, contentHash, jobId).first<{ status: string; received_at: string }>();
  if (!existing || existing.status === 'completed') return 'duplicate';
  const staleBefore = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const reclaimed = await db.prepare("UPDATE deployment_callbacks SET status = 'processing', received_at = ?, attempts = attempts + 1, processed_at = NULL WHERE repository = ? AND commit_sha = ? AND content_hash = ? AND job_id = ? AND status = 'processing' AND received_at < ?").bind(now, repository, commit, contentHash, jobId, staleBefore).run();
  return reclaimed.meta.changes ? 'claimed' : 'busy';
}

async function markDeliveryProcessed(db: D1Database, delivery: string) {
  const now = new Date().toISOString();
  await db.prepare("UPDATE webhook_events SET status = 'processed', processed_at = ? WHERE delivery_id = ? AND status = 'processing'").bind(now, delivery).run();
}

async function markDeliveryFailed(db: D1Database, delivery: string) {
  await db.prepare("UPDATE webhook_events SET status = 'failed', processed_at = NULL WHERE delivery_id = ? AND status = 'processing'").bind(delivery).run();
}
async function verifySignature(body: string, signature: string, secret: string) {
  if (!secret) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body))); const actual = Uint8Array.from(signature.match(/.{2}/g) ?? [], (byte) => Number.parseInt(byte, 16));
  if (expected.length !== actual.length) return false; let result = 0; for (let index = 0; index < expected.length; index += 1) result |= expected[index] ^ actual[index]; return result === 0;
}
