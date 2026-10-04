import type { Context } from 'hono';
import { readSession, validCsrf, type AuthSession } from './auth.js';
import type { AppEnv } from './types.js';

export class SubmissionAuthFailure extends Error {
  constructor(public readonly code: string, message: string, public readonly status: 401 | 403) { super(message); }
}

export async function submissionActor(context: Context<AppEnv>, owner?: number | null): Promise<AuthSession | null> {
  const actor = await readSession(context);
  if (owner !== undefined && owner !== null && !actor)
    throw new SubmissionAuthFailure('login_required', '请登录原投稿账号，再继续上传或公开。', 401);
  if (owner !== undefined && owner !== null && actor?.userId !== owner)
    throw new SubmissionAuthFailure('submission_owner_required', '请使用原投稿账号完成这份投稿。', 403);
  if (actor && !validCsrf(context, actor, context.req.header('X-CSRF-Token')))
    throw new SubmissionAuthFailure('csrf_invalid', '请求已失效，请刷新页面后重试。', 403);
  return actor;
}

// Repeat the cookie authority check inside every authenticated write batch.
// Expiry or logout during image processing/publication rolls the batch back.
export function submissionSessionAssertion(env: AppEnv['Bindings'], actor: AuthSession) {
  return env.DB.prepare(`INSERT INTO live_write_assertion(ok) VALUES(CASE WHEN EXISTS (
    SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.user_id=? AND s.expires_at>unixepoch() AND u.issuer=?
  ) THEN 1 ELSE 0 END)`).bind(actor.sessionHash, actor.userId, env.OIDC_ISSUER ?? 'https://auth.shoumc.com/api/auth');
}

export function submissionWriteAssertion(db: D1Database) {
  return db.prepare('INSERT INTO live_write_assertion(ok) VALUES(CASE WHEN changes()=1 THEN 1 ELSE 0 END)');
}
