import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { Hono } from 'hono';
import worker from '../src/worker/index.ts';
import { authConfigured, beginLogin, completeLogin, endSession, readSession, safeReturnTo, tokenHash, trustedPicture, SESSION_TTL, ADMIN_TTL } from '../src/worker/auth.ts';
import { requireAccess } from '../src/worker/security.ts';
import { adminApiBase, adminRequest, AdminRequestError } from '../src/utils/auth-session.ts';

const origin = 'https://eat.shoumc.com';
const issuer = 'https://auth.shoumc.com/api/auth';
const config = { OIDC_ISSUER: issuer, OIDC_CLIENT_ID: 'eat-test-client', OIDC_CLIENT_SECRET: 'test-only-secret', OIDC_REDIRECT_URI: origin + '/auth/callback' };
const now = () => Math.floor(Date.now() / 1000);
const b64 = value => Buffer.from(value).toString('base64url');
const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', keyPair.publicKey)), kid: 'test-auth-key', alg: 'RS256', use: 'sig' };

class Statement {
  constructor(db, sql, values = []) { Object.assign(this, { db, sql, values }); }
  bind(...values) { return new Statement(this.db, this.sql, values); }
  runSync() { return { meta: { changes: Number(this.db.prepare(this.sql).run(...this.values).changes) } }; }
  async run() { return this.runSync(); }
  async first() { return this.db.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.db.prepare(this.sql).all(...this.values) }; }
}
class SqliteD1 {
  constructor() {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON');
    for (const name of readdirSync(new URL('../migrations/', import.meta.url)).filter(name => name.endsWith('.sql')).sort()) this.sqlite.exec(readFileSync(new URL('../migrations/' + name, import.meta.url), 'utf8'));
  }
  prepare(sql) { return new Statement(this.sqlite, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const results = statements.map(statement => statement.runSync()); this.sqlite.exec('COMMIT'); return results; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  close() { this.sqlite.close(); }
}

function runtime(db, overrides = {}) {
  return { ...config, DB: db, ASSETS: { fetch: async () => new Response('public catalog') }, ALLOWED_ORIGINS: origin, PUBLICATION_ENABLED: 'true', MEDIA_MODE: 'external', TURNSTILE_SECRET_KEY: 'test-turnstile', TURNSTILE_HOSTNAME: 'eat.shoumc.com', ...overrides };
}

function provider() {
  const grants = new Map();
  let tokenCalls = 0;
  const mock = {
    profile: { sub: 'subject-1', preferred_username: '海大同学', email: 'private@invalid.test', email_verified: true, roles: ['user'], roles_checked_at: now() },
    get tokenCalls() { return tokenCalls; },
    grant(authorization, overrides = {}, corrupt = false) {
      const authorizationUrl = new URL(authorization), code = 'test-code-' + crypto.randomUUID();
      grants.set(code, { authorizationUrl, overrides, corrupt });
      return '/auth/callback?' + new URLSearchParams({ code, state: authorizationUrl.searchParams.get('state') });
    },
    async fetch(address, init) {
      const url = new URL(address);
      if (url.href === issuer + '/.well-known/openid-configuration') return Response.json({ issuer, authorization_endpoint: issuer + '/oauth2/authorize', token_endpoint: issuer + '/oauth2/token', userinfo_endpoint: issuer + '/oauth2/userinfo', jwks_uri: issuer + '/jwks', response_types_supported: ['code'], id_token_signing_alg_values_supported: ['RS256'], token_endpoint_auth_methods_supported: ['client_secret_basic'], code_challenge_methods_supported: ['S256'] });
      if (url.href === issuer + '/jwks') return Response.json({ keys: [jwk] });
      if (url.href === issuer + '/oauth2/userinfo') {
        assert.equal(new Headers(init.headers).get('Authorization'), 'Bearer access-token-never-persisted');
        return Response.json(mock.profile);
      }
      assert.equal(url.href, issuer + '/oauth2/token');
      tokenCalls++;
      const auth = new Headers(init.headers).get('Authorization');
      assert.ok(auth?.startsWith('Basic '));
      assert.deepEqual(Buffer.from(auth.slice(6), 'base64').toString().split(':').map(decodeURIComponent), [config.OIDC_CLIENT_ID, config.OIDC_CLIENT_SECRET]);
      const body = new URLSearchParams(init.body), grant = grants.get(body.get('code'));
      if (!grant) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      grants.delete(body.get('code'));
      assert.equal(body.get('redirect_uri'), config.OIDC_REDIRECT_URI);
      assert.equal(b64(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body.get('code_verifier')))), grant.authorizationUrl.searchParams.get('code_challenge'));
      const claims = { iss: issuer, aud: config.OIDC_CLIENT_ID, sub: 'subject-1', iat: now(), exp: now() + 3600, nonce: grant.authorizationUrl.searchParams.get('nonce'), ...grant.overrides };
      const unsigned = b64(JSON.stringify({ alg: 'RS256', kid: jwk.kid })) + '.' + b64(JSON.stringify(claims));
      const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keyPair.privateKey, new TextEncoder().encode(unsigned)));
      if (grant.corrupt) signature[0] ^= 255;
      return Response.json({ access_token: 'access-token-never-persisted', token_type: 'Bearer', expires_in: 3600, id_token: unsigned + '.' + b64(signature) });
    },
  };
  return mock;
}

function harness(env, mock) {
  const jar = new Map();
  const app = new Hono();
  app.get('/auth/login', async context => context.redirect(await beginLogin(context, false, mock.fetch), 303));
  app.get('/auth/register', async context => context.redirect(await beginLogin(context, true, mock.fetch), 303));
  app.get('/auth/callback', async context => context.redirect(await completeLogin(context, mock.fetch), 303));
  app.post('/auth/logout', async context => context.redirect(await endSession(context), 303));
  app.get('/session', async context => context.json(await readSession(context)));
  app.use('/private', requireAccess);
  app.get('/private', context => context.json({ reviewer: context.get('reviewer') }));
  app.post('/private', context => context.json({ reviewer: context.get('reviewer') }));
  app.onError((reason, context) => context.json({ failure: true }, reason.status ?? 503));
  return {
    jar,
    async request(path, init = {}) {
      const headers = new Headers(init.headers);
      if (!headers.has('Cookie')) headers.set('Cookie', [...jar].map(([name, value]) => `${name}=${value}`).join('; '));
      const response = await app.request(origin + path, { ...init, headers }, env);
      for (const cookie of response.headers.getSetCookie()) {
        const [pair] = cookie.split(';'), at = pair.indexOf('='), name = pair.slice(0, at), value = pair.slice(at + 1);
        if (value) jar.set(name, value); else jar.delete(name);
      }
      return response;
    },
  };
}

async function fixture(run) { const db = new SqliteD1(); try { await run(db); } finally { db.close(); } }
async function login(client, mock, overrides = {}) {
  const start = await client.request('/auth/login?returnTo=%2Fmanage%2F');
  assert.equal(start.status, 303);
  const finish = await client.request(mock.grant(start.headers.get('Location'), overrides));
  assert.equal(finish.status, 303);
  return (await client.request('/session')).json();
}

test('return paths cannot become external redirects or authentication loops', () => {
  for (const path of ['https://evil.test', '//evil.test', '/\\evil.test', '/%5Cevil.test', '/%2F%2Fevil.test', '/a/..//evil.test', '/%2e%2e//evil.test', '/auth/login', '/auth/callback?code=secret', '/a\nlocation:evil', '/a%00b', 'not/a/path']) assert.equal(safeReturnTo(path), '/', path);
  assert.equal(safeReturnTo('/foods/noodles/?write=1#review-form'), '/foods/noodles/?write=1#review-form');
});

test('OIDC registration binds browser, PKCE, state and nonce; only opaque session hashes persist', async () => fixture(async db => {
  const mock = provider(), client = harness(runtime(db), mock);
  const target = '/foods/noodles/?write=1#review-form';
  const start = await client.request('/auth/register?' + new URLSearchParams({ returnTo: target }));
  assert.equal(start.status, 303);
  const authorization = start.headers.get('Location'), url = new URL(authorization);
  assert.equal(url.searchParams.get('prompt'), 'create');
  assert.equal(url.searchParams.get('scope'), 'openid profile email');
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
  assert.ok(url.searchParams.get('nonce'));
  assert.ok(url.searchParams.get('state'));
  assert.equal(url.searchParams.has('client_secret'), false);
  assert.match(start.headers.get('Set-Cookie'), /__Host-eat-login=.*; Max-Age=600; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const transaction = await db.prepare('SELECT * FROM auth_login_transactions').first();
  assert.equal(transaction.state_hash, await tokenHash(url.searchParams.get('state')));
  assert.equal(transaction.browser_hash, await tokenHash(client.jar.get('__Host-eat-login')));
  const callback = mock.grant(authorization);
  const attacker = await client.request(callback, { headers: { Cookie: '__Host-eat-login=' + 'x'.repeat(43) } });
  assert.equal(attacker.status, 400);
  assert.equal(mock.tokenCalls, 0);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_login_transactions').first()).count, 1);
  const finished = await client.request(callback);
  assert.equal(finished.status, 303);
  assert.equal(finished.headers.get('Location'), target);
  assert.equal(client.jar.has('__Host-eat-login'), false);
  const token = client.jar.get('__Host-eat-session');
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(finished.headers.get('Set-Cookie'), /__Host-eat-session=.*; Max-Age=28800; Path=\/; HttpOnly; Secure; SameSite=Lax/);
  const stored = await db.prepare('SELECT * FROM auth_sessions').first();
  assert.equal(stored.token_hash, await tokenHash(token));
  assert.equal(stored.expires_at - stored.created_at, SESSION_TTL);
  assert.equal(JSON.stringify(stored).includes(token), false);
  assert.doesNotMatch(JSON.stringify(stored), /access-token|id_token|private@invalid.test/);
  assert.doesNotMatch(JSON.stringify(await db.prepare('SELECT * FROM auth_users').first()), /private@invalid.test/);
  assert.equal((await client.request('/session').then(response => response.json())).username, '海大同学');
  assert.equal((await client.request(callback)).status, 400);
  assert.equal(mock.tokenCalls, 1);
}));

test('invalid signature, issuer, audience, nonce, expiry or profile fail closed and consume the transaction once', async () => fixture(async db => {
  for (const [claims, corrupt, profile] of [
    [{}, true], [{ iss: 'https://evil.test' }], [{ aud: 'wrong-client' }], [{ nonce: 'wrong' }], [{ exp: 1 }], [{ sub: '' }],
    [{}, false, { sub: 'wrong-subject' }], [{}, false, { email_verified: false }], [{}, false, { preferred_username: 'private@invalid.test' }], [{}, false, { email: 'invalid' }],
  ]) {
    const mock = provider(), client = harness(runtime(db), mock);
    Object.assign(mock.profile, profile);
    const start = await client.request('/auth/login'), callback = mock.grant(start.headers.get('Location'), claims, corrupt);
    assert.ok([400, 503].includes((await client.request(callback)).status));
    assert.equal(client.jar.has('__Host-eat-session'), false);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first()).count, 0);
    assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_login_transactions').first()).count, 0);
    assert.equal((await client.request(callback)).status, 400);
    assert.equal(mock.tokenCalls, 1);
  }
}));

test('expired transaction, duplicated state and concurrent callback use never exchange twice', async () => fixture(async db => {
  const mock = provider(), client = harness(runtime(db), mock);
  let start = await client.request('/auth/login'), callback = mock.grant(start.headers.get('Location'));
  assert.equal((await client.request(callback + '&state=' + new URL(start.headers.get('Location')).searchParams.get('state'))).status, 400);
  await db.prepare('UPDATE auth_login_transactions SET expires_at = 1').run();
  assert.equal((await client.request(callback)).status, 400);
  assert.equal(mock.tokenCalls, 0);
  start = await client.request('/auth/login'); callback = mock.grant(start.headers.get('Location'));
  const responses = await Promise.all([client.request(callback), client.request(callback)]);
  assert.deepEqual(responses.map(response => response.status).sort(), [303, 400]);
  assert.equal(mock.tokenCalls, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first()).count, 1);
}));

test('central roles come from current authenticated UserInfo, expire within one hour and cannot be supplied by headers', async () => fixture(async db => {
  const mock = provider(), env = runtime(db), client = harness(env, mock);
  let session = await login(client, mock, { roles: ['admin'], name: 'admin', email: 'admin@invalid.test' });
  assert.equal(session.isAdmin, false);
  const spoofed = await client.request('/private?roles=admin&isAdmin=true', { headers: { 'Cf-Access-Authenticated-User-Email': 'admin@invalid.test', 'X-User-Role': 'admin' } });
  assert.equal(spoofed.status, 403);
  mock.profile.roles = ['admin']; mock.profile.roles_checked_at = now();
  session = await login(client, mock);
  assert.equal(session.isAdmin, true);
  assert.equal(ADMIN_TTL, 3600);
  assert.ok(session.adminExpiresAt >= now() + 3590);
  assert.ok(session.adminExpiresAt <= now() + ADMIN_TTL);
  assert.equal((await client.request('/private')).status, 200);
  const cookie = '__Host-eat-session=' + client.jar.get('__Host-eat-session');
  for (const path of ['/api/manage/v1/submissions?status=pending', '/api/manage/v2/content', '/api/v2/admin/content']) {
    const response = await worker.fetch(new Request(origin + path, { headers: { Cookie: cookie } }), env, {});
    assert.equal(response.status, 200, path);
  }
  await db.prepare('UPDATE auth_sessions SET admin_until=1').run();
  session = await client.request('/session').then(response => response.json());
  assert.equal(session.isAdmin, false);
  assert.equal(session.wasAdmin, true);
  assert.equal((await client.request('/private')).status, 401);
  const expired = await worker.fetch(new Request(origin + '/api/manage/v2/content', { headers: { Cookie: cookie } }), env, {});
  assert.equal(expired.status, 401);
  assert.equal((await expired.json()).error.loginUrl, '/auth/login?returnTo=%2Fmanage%2F');
  mock.profile.roles = ['user'];
  assert.equal((await login(client, mock)).wasAdmin, false);
  assert.equal((await client.request('/private')).status, 403);
}));

test('admin freshness never extends an expired token, stale role check or future role timestamp', async () => fixture(async db => {
  for (const checkedAt of [now() - 3601, now() + 60, undefined, NaN, 1.5, '3600']) {
    const mock = provider(), client = harness(runtime(db), mock);
    mock.profile.roles = ['admin']; mock.profile.roles_checked_at = checkedAt;
    assert.equal((await login(client, mock)).isAdmin, false);
  }
  const mock = provider(), client = harness(runtime(db), mock);
  mock.profile.roles = ['admin']; mock.profile.roles_checked_at = now();
  assert.ok((await login(client, mock, { exp: now() + 60 })).adminExpiresAt <= now() + 60);
  assert.ok((await login(client, mock, { exp: now() + 7200 })).adminExpiresAt <= now() + 3600);
  mock.profile.roles_checked_at = now() - 1800;
  assert.ok((await login(client, mock)).adminExpiresAt <= now() + 1800);
}));

test('cookie admin writes require the exact origin and current CSRF token', async () => fixture(async db => {
  const mock = provider(), env = runtime(db), client = harness(env, mock);
  mock.profile.roles = ['admin'];
  const session = await login(client, mock);
  for (const headers of [{}, { Origin: 'https://evil.test', 'X-CSRF-Token': session.csrfToken }, { Origin: origin, 'X-CSRF-Token': 'wrong' }, { 'X-CSRF-Token': session.csrfToken }]) {
    const denied = await client.request('/private', { method: 'POST', headers });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).error.code, 'csrf_invalid');
  }
  const allowed = await client.request('/private', { method: 'POST', headers: { Origin: origin, 'X-CSRF-Token': session.csrfToken } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).reviewer, 'auth:1:海大同学');
  const denied = await worker.fetch(new Request(origin + '/api/manage/v2/submissions/missing/review', { method: 'POST', headers: { Cookie: '__Host-eat-session=' + client.jar.get('__Host-eat-session'), Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reject', expectedVersion: 1, reason: 'test' }) }), env, {});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error.code, 'csrf_invalid');
}));

test('session rotation keeps issuer and subject identity; expired sessions and logout revoke browser credentials', async () => fixture(async db => {
  const mock = provider(), client = harness(runtime(db), mock);
  await login(client, mock);
  const oldToken = client.jar.get('__Host-eat-session');
  mock.profile.preferred_username = '新用户名';
  const session = await login(client, mock);
  assert.equal(session.username, '新用户名');
  assert.notEqual(client.jar.get('__Host-eat-session'), oldToken);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_users').first()).count, 1);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first()).count, 1);
  const staleBrowser = harness(runtime(db), mock);
  assert.equal(await staleBrowser.request('/session', { headers: { Cookie: '__Host-eat-session=' + oldToken } }).then(response => response.json()), null);
  for (const [requestOrigin, csrfToken] of [['https://evil.test', session.csrfToken], [origin, 'wrong']]) {
    const denied = await client.request('/auth/logout', { method: 'POST', headers: { Origin: requestOrigin }, body: new URLSearchParams({ csrfToken }) });
    assert.equal(denied.status, 400);
    assert.ok(await client.request('/session').then(response => response.json()));
  }
  const loggedOut = await client.request('/auth/logout', { method: 'POST', headers: { Origin: origin }, body: new URLSearchParams({ csrfToken: session.csrfToken, returnTo: '/foods/?q=rice' }) });
  assert.equal(loggedOut.status, 303);
  assert.equal(loggedOut.headers.get('Location'), '/foods/?q=rice');
  assert.equal(client.jar.has('__Host-eat-session'), false);
  assert.equal((await db.prepare('SELECT COUNT(*) AS count FROM auth_sessions').first()).count, 0);
  await login(client, mock);
  await db.prepare('UPDATE auth_sessions SET expires_at=1').run();
  assert.equal(await client.request('/session').then(response => response.json()), null);
  assert.equal(client.jar.has('__Host-eat-session'), false);
}));

test('avatar URL is restricted to Auth immutable images and session JSON never exposes identity or OAuth tokens', async () => fixture(async db => {
  const picture = 'https://auth.shoumc.com/api/profile/avatar/' + 'a'.repeat(64) + '.png';
  assert.equal(trustedPicture(picture, new URL(issuer)), picture);
  for (const value of ['https://evil.test/avatar.png', 'javascript:alert(1)', picture + '?secret=x', picture.replace('.png', '.svg'), 'https://user:password@auth.shoumc.com/api/profile/avatar/' + 'a'.repeat(64) + '.png']) assert.equal(trustedPicture(value, new URL(issuer)), null);
  const mock = provider(), env = runtime(db), client = harness(env, mock);
  mock.profile.picture = picture;
  await login(client, mock);
  const response = await worker.fetch(new Request(origin + '/auth/session', { headers: { Cookie: '__Host-eat-session=' + client.jar.get('__Host-eat-session') } }), env, {});
  assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
  assert.equal(response.headers.get('Vary'), 'Cookie');
  const data = await response.json();
  assert.equal(data.user.picture, picture);
  assert.ok(data.csrfToken);
  assert.doesNotMatch(JSON.stringify(data), /subject-1|private@invalid.test|access-token|userId|token_hash|issuer|secret/);
  const crossOrigin = await worker.fetch(new Request(origin + '/auth/session', { headers: { Origin: 'https://evil.test' } }), env, {});
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers.has('Access-Control-Allow-Origin'), false);
}));

test('anonymous browsing executes no auth SQL and missing/insecure configuration fails without leaking secrets', async () => {
  const app = new Hono();
  app.get('/', async context => context.json(await readSession(context)));
  const noDb = { ...config, get DB() { throw new Error('Anonymous auth must not access D1'); } };
  assert.equal(await app.request(origin + '/', {}, noDb).then(response => response.json()), null);
  const mock = provider(), unused = { prepare() { throw new Error('Invalid config must fail before SQL'); } };
  for (const override of [{ OIDC_CLIENT_SECRET: undefined }, { OIDC_REDIRECT_URI: 'http://eat.shoumc.com/auth/callback' }, { OIDC_ISSUER: 'http://auth.shoumc.com/api/auth', OIDC_ALLOW_LOCAL_HTTP: 'true' }, { OIDC_REDIRECT_URI: origin + '/auth/callback?extra=x' }]) {
    const client = harness(runtime(unused, override), mock);
    assert.equal((await client.request('/auth/login')).status, 503);
  }
  assert.equal(authConfigured(runtime(unused, { OIDC_REDIRECT_URI: 'http://localhost:8789/auth/callback', OIDC_ALLOW_LOCAL_HTTP: 'true' }), new URL('http://localhost:8789')), true);
  assert.equal(authConfigured(runtime(unused), new URL('https://other.test')), false);
  const env = runtime(unused, { OIDC_CLIENT_SECRET: undefined });
  const failed = await worker.fetch(new Request(origin + '/auth/login?client_secret=do-not-echo'), env, {});
  assert.equal(failed.status, 503);
  assert.match(await failed.text(), /账号服务暂时不可用/);
  assert.equal((await worker.fetch(new Request(origin + '/'), env, {}).then(response => response.text())), 'public catalog');
});

test('admin browser transport selects unified paths and sends freshly read CSRF only on writes', async () => {
  assert.equal(adminApiBase('/manage/'), '/api/manage/v2');
  assert.equal(adminApiBase('/admin/'), '/api/v2/admin');
  const calls = [];
  const send = async (path, init) => { calls.push({ path, init }); return path === '/auth/session' ? Response.json({ user: { isAdmin: true }, csrfToken: 'fresh-csrf' }) : Response.json({ saved: true }); };
  assert.deepEqual(await adminRequest('/content', {}, send, '/api/manage/v2'), { saved: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.headers.has('X-CSRF-Token'), false);
  await adminRequest('/content/food/noodles', { method: 'POST', body: '{}' }, send, '/api/manage/v2');
  assert.equal(calls[1].path, '/auth/session');
  assert.equal(calls[2].init.headers.get('X-CSRF-Token'), 'fresh-csrf');
  assert.equal(calls[2].init.credentials, 'same-origin');
  await assert.rejects(adminRequest('/content', {}, async () => Response.json({ error: { code: 'admin_session_expired', message: '请重新确认' } }, { status: 401 }), '/api/manage/v2'), error => error instanceof AdminRequestError && error.code === 'admin_session_expired');
});
