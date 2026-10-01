import type { Context } from 'hono';
import { missingReviewConfig, publicationEnabled } from './config.js';
import type { AppEnv } from './types.js';

export async function verifyTurnstile(token: unknown, secret: string, remoteIp?: string | null): Promise<boolean> {
  if (typeof token !== 'string' || !token) return false;
  const form = new FormData(); form.set('secret', secret); form.set('response', token); if (remoteIp) form.set('remoteip', remoteIp);
  try { const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form }); const result = await response.json() as { success?: boolean }; return response.ok && Boolean(result.success); } catch { return false; }
}

export async function requireAccess(context: Context<AppEnv>, next: () => Promise<void>) {
  const assertion = context.req.header('Cf-Access-Jwt-Assertion');
  if (!assertion) return context.json({ error: { code: 'unauthorized', message: '需要审核员登录。' } }, 401, { 'Cache-Control': 'no-store' });
  if (!publicationEnabled(context.env)) return context.json({ error: { code: 'service_unavailable', message: '投稿审核功能尚未启用。' } }, 503, { 'Cache-Control': 'no-store' });
  if (missingReviewConfig(context.env).length) return context.json({ error: { code: 'service_unavailable', message: '审核服务暂未配置完成，请稍后重试。' } }, 503, { 'Cache-Control': 'no-store' });
  try {
    const url = new URL(`https://${context.env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`);
    const response = await fetch(url);
    if (!response.ok) throw new Error('access_keys_unavailable');
    const { keys } = await response.json() as { keys: JsonWebKey[] };
    const claims = await verifyJwt(assertion, keys, context.env.ACCESS_AUD, `https://${context.env.ACCESS_TEAM_DOMAIN}`);
    const email = typeof claims.email === 'string' ? claims.email : null;
    if (!email) throw new Error('missing_email');
    context.set('reviewer', email);
    context.header('Cache-Control', 'no-store');
    await next();
  } catch { return context.json({ error: { code: 'unauthorized', message: '审核员凭据无效或已过期。' } }, 401, { 'Cache-Control': 'no-store' }); }
}

async function verifyJwt(token: string, jwks: JsonWebKey[], audience: string, issuer: string) {
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
