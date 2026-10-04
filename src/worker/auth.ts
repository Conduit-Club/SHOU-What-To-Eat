import * as oidc from 'openid-client';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { Context } from 'hono';
import type { AppEnv } from './types.js';
import { readLimitedBody } from './media.js';

export const SESSION_TTL = 8 * 60 * 60;
export const LOGIN_TTL = 10 * 60;
export const ADMIN_TTL = 60 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const seconds = () => Math.floor(Date.now() / 1000);
const loopback = (host: string) => ['localhost', '127.0.0.1', '[::1]'].includes(host);
type Bindings = AppEnv['Bindings'];
type AuthContext = Context<AppEnv>;
type Settings = { issuer: URL; clientId: string; secret: string; callback: URL; localHttp: boolean };

export type AuthSession = {
  userId: number;
  sessionHash: string;
  username: string;
  picture: string | null;
  csrfToken: string;
  expiresAt: number;
  isAdmin: boolean;
  wasAdmin: boolean;
  adminExpiresAt: number;
};

export class AuthFailure extends Error {
  constructor(public readonly status: 400 | 403 | 503) { super('Authentication failed'); }
}

function settings(env: Bindings): Settings {
  try {
    if (!env.OIDC_CLIENT_ID?.trim() || !env.OIDC_CLIENT_SECRET?.trim() || !env.OIDC_REDIRECT_URI) throw new Error();
    const issuer = new URL(env.OIDC_ISSUER ?? 'https://auth.shoumc.com/api/auth');
    const callback = new URL(env.OIDC_REDIRECT_URI);
    for (const address of [issuer, callback]) {
      if (address.username || address.password || address.search || address.hash) throw new Error();
      if (address.protocol !== 'https:' && !(address.protocol === 'http:' && env.OIDC_ALLOW_LOCAL_HTTP === 'true' && loopback(address.hostname))) throw new Error();
    }
    if (callback.pathname !== '/auth/callback') throw new Error();
    return { issuer, callback, clientId: env.OIDC_CLIENT_ID, secret: env.OIDC_CLIENT_SECRET, localHttp: issuer.protocol === 'http:' };
  } catch { throw new AuthFailure(503); }
}

export function authConfigured(env: Bindings, url: URL): boolean {
  try { return Boolean(env.DB) && settings(env).callback.origin === url.origin; }
  catch { return false; }
}

function requestSettings(context: AuthContext) {
  const config = settings(context.env);
  if (!context.env.DB || config.callback.origin !== new URL(context.req.url).origin) throw new AuthFailure(503);
  return { config, db: context.env.DB };
}

// Cache provider metadata only. Browser binding, PKCE, nonce and sessions survive
// isolate restarts in D1; no user or OAuth token is held in this cache.
let providerCache: { key: string; expiresAt: number; promise: Promise<oidc.Configuration> } | undefined;
export async function discoverProvider(env: Bindings, fetcher?: oidc.CustomFetch) {
  const config = settings(env);
  const key = `${config.issuer.href}\n${config.clientId}\n${config.secret}\n${config.callback.href}`;
  if (!fetcher && providerCache?.key === key && providerCache.expiresAt > seconds()) return providerCache.promise;
  const promise = oidc.discovery(config.issuer, config.clientId,
    { client_secret: config.secret, redirect_uris: [config.callback.href] }, oidc.ClientSecretBasic(config.secret), {
      timeout: 10,
      execute: [oidc.enableNonRepudiationChecks, ...(config.localHttp ? [oidc.allowInsecureRequests] : [])],
      ...(fetcher ? { [oidc.customFetch]: fetcher } : {}),
    });
  if (!fetcher) {
    providerCache = { key, expiresAt: seconds() + LOGIN_TTL, promise };
    promise.catch(() => { if (providerCache?.promise === promise) providerCache = undefined; });
  }
  return promise;
}

export function safeReturnTo(value: string | null | undefined): string {
  const unsafe = (text: string) => /[\\\x00-\x1f\x7f]/.test(text);
  if (!value || value.length > 2000 || !value.startsWith('/') || value.startsWith('//') || unsafe(value)) return '/';
  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith('//') || unsafe(decoded)) return '/';
    const destination = new URL(value, 'https://eat.invalid');
    if (destination.origin !== 'https://eat.invalid' || destination.pathname.startsWith('//') || /^\/auth(?:\/|$)/.test(destination.pathname)) return '/';
    return `${destination.pathname}${destination.search}${destination.hash}`;
  } catch { return '/'; }
}

export const tokenHash = async (token: string) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token)))).map(byte => byte.toString(16).padStart(2, '0')).join('');

function cookieName(context: AuthContext, type: 'session' | 'login') {
  return new URL(context.req.url).protocol === 'https:' ? `__Host-eat-${type}` : `eat-dev-${type}`;
}
function cookieOptions(context: AuthContext) {
  return { path: '/', httpOnly: true, secure: new URL(context.req.url).protocol === 'https:', sameSite: 'Lax' as const };
}
function writeCookie(context: AuthContext, type: 'session' | 'login', token: string, maxAge: number) {
  setCookie(context, cookieName(context, type), token, { ...cookieOptions(context), maxAge });
}
function clearCookie(context: AuthContext, type: 'session' | 'login') {
  deleteCookie(context, cookieName(context, type), cookieOptions(context));
}

export async function readSession(context: AuthContext): Promise<AuthSession | null> {
  const cached = context.get('authSession');
  if (cached !== undefined) return cached;
  const token = getCookie(context, cookieName(context, 'session'));
  // Public, anonymous requests do not execute any authentication SQL.
  if (!token || !TOKEN_PATTERN.test(token)) return null;
  const url = new URL(context.req.url);
  if (url.protocol !== 'https:' && !(context.env.OIDC_ALLOW_LOCAL_HTTP === 'true' && loopback(url.hostname))) return null;
  if (!context.env.DB) return null;
  const record = await context.env.DB.prepare(`SELECT u.id AS userId, u.username, u.picture, u.issuer, s.token_hash AS sessionHash,
      s.csrf_token AS csrfToken, s.expires_at AS expiresAt, s.was_admin AS wasAdmin, s.admin_until AS adminExpiresAt
    FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?`)
    .bind(await tokenHash(token), seconds())
    .first<Omit<AuthSession, 'isAdmin' | 'wasAdmin'> & { issuer: string; wasAdmin: number }>();
  if (!record || record.issuer !== (context.env.OIDC_ISSUER ?? 'https://auth.shoumc.com/api/auth')) {
    clearCookie(context, 'session'); context.set('authSession', null); return null;
  }
  const { issuer: _issuer, ...profile } = record;
  const session = { ...profile, wasAdmin: record.wasAdmin === 1, isAdmin: record.wasAdmin === 1 && record.adminExpiresAt > seconds() };
  context.set('authSession', session);
  return session;
}

function trustedUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const username = value.normalize('NFKC').trim().toLowerCase();
  return /^[a-z0-9\u3400-\u9fff][a-z0-9_\-\u3400-\u9fff]{1,23}$/.test(username) ? username : null;
}

export function trustedPicture(value: unknown, issuer: URL): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.origin === issuer.origin && !url.username && !url.password && !url.search && !url.hash && /^\/api\/profile\/avatar\/[a-f0-9]{64}\.png$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

async function pruneExpired(db: D1Database) {
  await db.batch([
    db.prepare(`DELETE FROM auth_login_transactions WHERE state_hash IN
      (SELECT state_hash FROM auth_login_transactions WHERE expires_at <= ? ORDER BY expires_at LIMIT 50)`).bind(seconds()),
    db.prepare(`DELETE FROM auth_sessions WHERE token_hash IN
      (SELECT token_hash FROM auth_sessions WHERE expires_at <= ? ORDER BY expires_at LIMIT 50)`).bind(seconds()),
  ]);
}

export async function beginLogin(context: AuthContext, register = false, fetcher?: oidc.CustomFetch): Promise<string> {
  const { config, db } = requestSettings(context);
  const provider = await discoverProvider(context.env, fetcher);
  const state = oidc.randomState(), browserToken = oidc.randomState(), verifier = oidc.randomPKCECodeVerifier(), nonce = oidc.randomNonce();
  const authorization = oidc.buildAuthorizationUrl(provider, {
    redirect_uri: config.callback.href, response_type: 'code', scope: 'openid profile email',
    code_challenge: await oidc.calculatePKCECodeChallenge(verifier), code_challenge_method: 'S256', state, nonce,
    ...(register ? { prompt: 'create' } : {}),
  });
  await pruneExpired(db);
  await db.prepare(`INSERT INTO auth_login_transactions
    (state_hash, browser_hash, verifier, nonce, return_to, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await tokenHash(state), await tokenHash(browserToken), verifier, nonce, safeReturnTo(context.req.query('returnTo')), seconds(), seconds() + LOGIN_TTL).run();
  writeCookie(context, 'login', browserToken, LOGIN_TTL);
  return authorization.href;
}

export async function completeLogin(context: AuthContext, fetcher?: oidc.CustomFetch): Promise<string> {
  const { config, db } = requestSettings(context);
  const url = new URL(context.req.url), state = url.searchParams.get('state'), browserToken = getCookie(context, cookieName(context, 'login'));
  if (!state || !TOKEN_PATTERN.test(state) || !browserToken || !TOKEN_PATTERN.test(browserToken) || url.pathname !== config.callback.pathname || url.searchParams.getAll('state').length !== 1) throw new AuthFailure(400);
  // Atomic consumption prevents callback replay, concurrent use and attempts to
  // exchange a code using another browser's authorization transaction.
  const transaction = await db.prepare(`DELETE FROM auth_login_transactions WHERE state_hash = ? AND browser_hash = ? AND expires_at > ? RETURNING verifier, nonce, return_to`)
    .bind(await tokenHash(state), await tokenHash(browserToken), seconds()).first<{ verifier: string; nonce: string; return_to: string }>();
  if (!transaction) throw new AuthFailure(400);
  clearCookie(context, 'login');
  const provider = await discoverProvider(context.env, fetcher);
  const tokens = await oidc.authorizationCodeGrant(provider, url, { pkceCodeVerifier: transaction.verifier, expectedState: state, expectedNonce: transaction.nonce, idTokenExpected: true });
  const claims = tokens.claims();
  if (!claims || !claims.sub || claims.sub.length > 255) throw new AuthFailure(400);
  // Authenticated UserInfo is checked against the signed ID Token's subject,
  // and recomputes the current canonical profile and authoritative admin role.
  const profile = await oidc.fetchUserInfo(provider, tokens.access_token, claims.sub);
  const username = trustedUsername(profile.preferred_username);
  if (!username || profile.email_verified !== true || typeof profile.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email) || profile.email.length > 254) throw new AuthFailure(400);
  const checkedAt = profile.roles_checked_at;
  const wasAdmin = Array.isArray(profile.roles) && profile.roles.includes('admin') && typeof checkedAt === 'number' && Number.isSafeInteger(checkedAt) && checkedAt <= seconds() + 30;
  const current = seconds();
  const fresh = wasAdmin && checkedAt > current - ADMIN_TTL && typeof claims.exp === 'number' && Number.isSafeInteger(claims.exp) && claims.exp > current;
  const adminUntil = fresh ? Math.min(claims.exp, checkedAt + ADMIN_TTL, current + ADMIN_TTL) : 0;
  const user = await db.prepare(`INSERT INTO auth_users (issuer, subject, username, picture, created_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (issuer, subject) DO UPDATE SET username = excluded.username, picture = excluded.picture, last_login_at = excluded.last_login_at RETURNING id`)
    .bind(config.issuer.href, claims.sub, username, trustedPicture(profile.picture, config.issuer), seconds(), seconds()).first<{ id: number }>();
  if (!user) throw new AuthFailure(503);
  const token = oidc.randomState(), oldToken = getCookie(context, cookieName(context, 'session'));
  const statements = [db.prepare(`INSERT INTO auth_sessions (token_hash, user_id, csrf_token, was_admin, admin_until, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(await tokenHash(token), user.id, oidc.randomState(), wasAdmin ? 1 : 0, adminUntil, seconds(), seconds() + SESSION_TTL)];
  if (oldToken && TOKEN_PATTERN.test(oldToken)) statements.push(db.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await tokenHash(oldToken)));
  await db.batch(statements);
  writeCookie(context, 'session', token, SESSION_TTL);
  return safeReturnTo(transaction.return_to);
}

export function validCsrf(context: AuthContext, session: AuthSession, token: unknown): boolean {
  return context.req.header('Origin') === new URL(context.req.url).origin && typeof token === 'string' && token === session.csrfToken;
}

export async function endSession(context: AuthContext): Promise<string> {
  if (context.req.method !== 'POST' || context.req.header('Origin') !== new URL(context.req.url).origin) throw new AuthFailure(400);
  if (Number(context.req.header('Content-Length') ?? 0) > 4096) throw new AuthFailure(400);
  const body = await readLimitedBody(context.req.raw, 4096);
  if (body.tooLarge || !body.bytes) throw new AuthFailure(400);
  const form = await new Response(new Uint8Array(body.bytes).buffer, { headers: { 'Content-Type': context.req.header('Content-Type') ?? '' } }).formData();
  const session = await readSession(context);
  if (session) {
    if (!validCsrf(context, session, form.get('csrfToken'))) throw new AuthFailure(400);
    const token = getCookie(context, cookieName(context, 'session'));
    if (!token) throw new AuthFailure(400);
    await context.env.DB.prepare('DELETE FROM auth_sessions WHERE token_hash = ?').bind(await tokenHash(token)).run();
  }
  clearCookie(context, 'session');
  return safeReturnTo(typeof form.get('returnTo') === 'string' ? form.get('returnTo') as string : '/');
}

export function accountUrl(context: AuthContext): string {
  const { config } = requestSettings(context);
  return new URL('/account', config.issuer).href;
}
