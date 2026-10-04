import type { Context } from 'hono';
import type { AuthSession } from './auth.js';
import type { AppEnv } from './types.js';

const ADMIN_SESSION_SQL = `SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
  WHERE s.token_hash=? AND s.user_id=? AND s.csrf_token=? AND s.expires_at>unixepoch()
    AND s.was_admin=1 AND s.admin_until>unixepoch() AND u.issuer=?`;
function authorityStatement(env: AppEnv['Bindings'], actor: AuthSession, sql: string) {
  return env.DB.prepare(sql).bind(actor.sessionHash, actor.userId, actor.csrfToken, env.OIDC_ISSUER ?? 'https://auth.shoumc.com/api/auth');
}

/** Only used after a failed write to distinguish lost authority from content errors. */
export async function adminSessionValid(env: AppEnv['Bindings'], actor: AuthSession) {
  return Boolean(await authorityStatement(env, actor, ADMIN_SESSION_SQL).first());
}

// Middleware grants the request, but logout or role expiry can occur during
// asynchronous R2/validation work. Check cookie authority at the write point.
export async function adminWriteBatch(env: AppEnv['Bindings'], statements: D1PreparedStatement[], actor?: AuthSession) {
  if (!actor) return env.DB.batch(statements); // Separately verified Access JWT or trusted scheduled operation.
  const guard = authorityStatement(env, actor, `INSERT INTO live_write_assertion(ok) VALUES(CASE WHEN EXISTS (${ADMIN_SESSION_SQL}) THEN 1 ELSE 0 END)`);
  const result = await env.DB.batch([guard, ...statements, env.DB.prepare('DELETE FROM live_write_assertion')]);
  return result.slice(1, -1);
}

export function adminBatch(context: Context<AppEnv>, statements: D1PreparedStatement[]) {
  return adminWriteBatch(context.env, statements, context.get('adminSession'));
}
