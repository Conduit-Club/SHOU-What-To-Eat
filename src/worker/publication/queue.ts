import { exportApprovedSubmission } from './github.js';
import type { AppEnv } from '../types.js';

export async function processPublicationQueue(env: AppEnv['Bindings']) {
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const claimId = crypto.randomUUID();
  const claimed = await env.DB.prepare("UPDATE publication_jobs SET status = 'running', attempts = attempts + 1, lease_until = ?, updated_at = ? WHERE id = (SELECT id FROM publication_jobs WHERE status = 'queued' OR status = 'running' AND lease_until < ? ORDER BY created_at LIMIT 1) AND (status = 'queued' OR lease_until < ?) RETURNING id, submission_id, submission_version, content_hash, branch, attempts").bind(leaseUntil, now, now, now).first<{ id: string; submission_id: string; submission_version: number; content_hash: string; branch: string; attempts: number }>();
  if (!claimed) return;
  try {
    const submission = await env.DB.prepare("SELECT type, target_restaurant_id, revision_json, original_json, version FROM submissions WHERE id = ? AND status = 'exporting'").bind(claimed.submission_id).first<{ type: string; target_restaurant_id: string | null; revision_json: string; original_json: string; version: number }>();
    if (!submission || submission.version !== claimed.submission_version) throw new Error('submission_revision_mismatch');
    const revision = JSON.parse(submission.revision_json) as Record<string, unknown>;
    if (await sha256(submission.revision_json) !== claimed.content_hash) throw new Error('submission_hash_mismatch');
    const result = await exportApprovedSubmission(env, { jobId: claimed.id, branch: claimed.branch, type: submission.type, targetId: submission.target_restaurant_id, revision, original: JSON.parse(submission.original_json), contentHash: claimed.content_hash });
    await env.DB.prepare("UPDATE publication_jobs SET status = 'pr_open', pr_number = ?, pr_url = ?, lease_until = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND status = 'running'").bind(result.number, result.html_url, new Date().toISOString(), claimed.id).run();
    await env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'export', ?, ?, ?)").bind(crypto.randomUUID(), claimed.submission_id, claimed.submission_version, result.html_url, new Date().toISOString()).run();
  } catch (error) {
    const code = (error instanceof Error ? error.message : 'export_failed').slice(0, 80);
    await env.DB.batch([
      env.DB.prepare("UPDATE publication_jobs SET status = 'failed', lease_until = NULL, error_code = ?, updated_at = ? WHERE id = ? AND status = 'running'").bind(code, new Date().toISOString(), claimed.id),
      env.DB.prepare("UPDATE submissions SET status = 'export_failed', updated_at = ? WHERE id = ? AND status = 'exporting'").bind(new Date().toISOString(), claimed.submission_id),
      env.DB.prepare("INSERT INTO audit_events (id, submission_id, reviewer, action, version, reason, created_at) VALUES (?, ?, 'system', 'export', ?, ?, ?)").bind(crypto.randomUUID(), claimed.submission_id, claimed.submission_version, code, new Date().toISOString()),
    ]);
  }
}

async function sha256(value: string) { const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)); return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join(''); }
