import type { Context } from 'hono';
import { missingSubmissionConfig, publicationEnabled } from './config.js';
import { readSession, validCsrf } from './auth.js';
import type { AppEnv } from './types.js';

export async function verifyTurnstile(token: unknown, secret: string, remoteIp?: string | null, expectedHostname?: string): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData(); form.set('secret', secret); form.set('response', token); if (remoteIp) form.set('remoteip', remoteIp);
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const result = await response.json() as { success?: boolean; action?: string; hostname?: string };
    return response.ok && result.success === true && result.action === 'submission' && (!expectedHostname || result.hostname === expectedHostname);
  } catch { return false; }
}

export async function requireAccess(context: Context<AppEnv>, next: () => Promise<void>) {
  const assertion = context.req.header('Cf-Access-Jwt-Assertion');
  const session = await readSession(context);
  const managementPath = context.req.path.startsWith('/api/manage/') ? '/manage/' : '/admin/';
  const loginUrl = '/auth/login?' + new URLSearchParams({ returnTo: managementPath });
  if (!assertion && !session?.isAdmin) return context.json({ error: {
    code: session?.wasAdmin ? 'admin_session_expired' : session ? 'admin_required' : 'unauthorized',
    message: session?.wasAdmin ? '管理员身份需要重新确认，已编辑内容仍保留在页面。' : session ? '此账号没有管理员权限。' : '请先登录管理员账号。',
    loginUrl,
  } }, session && !session.wasAdmin ? 403 : 401, { 'Cache-Control': 'no-store' });
  if (!publicationEnabled(context.env)) return context.json({ error: { code: 'service_unavailable', message: '投稿审核功能尚未启用。' } }, 503, { 'Cache-Control': 'no-store' });
  if (missingSubmissionConfig(context.env).length) return context.json({ error: { code: 'service_unavailable', message: '审核服务暂未配置完成，请稍后重试。' } }, 503, { 'Cache-Control': 'no-store' });
  if (session?.isAdmin) {
    if (!['GET', 'HEAD', 'OPTIONS'].includes(context.req.method) && !validCsrf(context, session, context.req.header('X-CSRF-Token'))) return context.json({ error: { code: 'csrf_invalid', message: '请求已失效，请刷新账号状态后重试。' } }, 403, { 'Cache-Control': 'no-store' });
    context.set('reviewer', `auth:${session.userId}:${session.username}`);
    context.set('adminSession', session);
    context.header('Cache-Control', 'private, no-store');
    context.header('Vary', 'Cookie');
    await next();
    return;
  }
  if (!context.env.ACCESS_TEAM_DOMAIN?.trim() || !context.env.ACCESS_AUD?.trim() || !context.env.ACCESS_REVIEWER_EMAIL?.trim()) return context.json({ error: { code: 'service_unavailable', message: '应急审核服务暂不可用。' } }, 503, { 'Cache-Control': 'no-store' });
  if (!assertion) return context.json({ error: { code: 'unauthorized', message: '请先登录管理员账号。', loginUrl } }, 401, { 'Cache-Control': 'no-store' });
  try {
    const url = new URL(`https://${context.env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const response = await fetch(url);
    if (!response.ok) throw new Error('access_keys_unavailable');
    const { keys } = await response.json() as { keys: JsonWebKey[] };
    const claims = await verifyJwt(assertion, keys, context.env.ACCESS_AUD, `https://${context.env.ACCESS_TEAM_DOMAIN}`);
    const email = typeof claims.email === 'string' ? claims.email : null;
    if (!email || email.toLowerCase() !== context.env.ACCESS_REVIEWER_EMAIL.trim().toLowerCase()) throw new Error('reviewer_not_allowed');
    context.set('reviewer', email);
  } catch { return context.json({ error: { code: 'unauthorized', message: '审核员凭据无效或已过期。' } }, 401, { 'Cache-Control': 'no-store' }); }
  context.header('Cache-Control', 'no-store');
  await next();
}

async function verifyJwt(token: string, jwks: JsonWebKey[], audience: string, issuer: string) {
  if (token.split('.').length !== 3) throw new Error('invalid_jwt');
  const [encodedHeader, encodedPayload, encodedSignature] = token.split('.');
  if (!encodedHeader || !encodedPayload || !encodedSignature) throw new Error('invalid_jwt');
  const decode = (value: string) => JSON.parse(atob(value.replace(/-/g, '+').replace(/_/g, '/')));
  const header = decode(encodedHeader) as { kid?: string; alg?: string };
  const payload = decode(encodedPayload) as { aud?: string | string[]; iss?: string; exp?: number; email?: string };
  if (header.alg !== 'RS256' || !header.kid || payload.iss !== issuer || !Array.isArray(payload.aud) && payload.aud !== audience || Array.isArray(payload.aud) && !payload.aud.includes(audience) || typeof payload.exp !== 'number' || payload.exp <= Date.now() / 1000) throw new Error('invalid_claims');
  const jwk = jwks.find((key) => (key as JsonWebKey & { kid?: string }).kid === header.kid);
  if (!jwk) throw new Error('unknown_key');
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
  const signature = Uint8Array.from(atob(encodedSignature.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0));
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, signature, new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`));
  if (!valid) throw new Error('invalid_signature');
  return payload;
}
