import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import worker from '../src/worker/index.ts';

const ACCESS_DOMAIN = 'team.example.cloudflareaccess.com';
const ACCESS_AUDIENCE = 'access-audience';
const ACCESS_EMAIL = 'reviewer@example.com';
const ACCESS_CERTS_URL = `https://${ACCESS_DOMAIN}/cdn-cgi/access/certs`;

function createDatabase() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(`
    CREATE TABLE submissions (id TEXT PRIMARY KEY, schema_version INTEGER NOT NULL, status TEXT DEFAULT 'exporting', entity_type TEXT, entity_id TEXT, revision_json TEXT DEFAULT '{}');
    CREATE TABLE publication_jobs (
      id TEXT PRIMARY KEY,
      submission_id TEXT NOT NULL,
      submission_version INTEGER NOT NULL,
      status TEXT NOT NULL,
      branch TEXT NOT NULL,
      pr_number INTEGER,
      pr_url TEXT,
      attempts INTEGER NOT NULL,
      error_code TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  return {
    sqlite,
    queryCount: 0,
    prepare(sql) {
      const database = this;
      const all = async (...values) => {
        database.queryCount += 1;
        return { results: database.sqlite.prepare(sql).all(...values) };
      };
      return {
        all: () => all(),
        bind(...values) { return { all: () => all(...values) }; },
      };
    },
  };
}

function env(database, overrides = {}) {
  return {
    DB: database,
    ASSETS: { fetch: async () => new Response('<!doctype html>') },
    MEDIA_MODE: 'external',
    ALLOWED_ORIGINS: 'https://eat.shoumc.com',
    PUBLICATION_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    TURNSTILE_HOSTNAME: 'eat.shoumc.com',
    ACCESS_TEAM_DOMAIN: ACCESS_DOMAIN,
    ACCESS_AUD: ACCESS_AUDIENCE,
    ACCESS_REVIEWER_EMAIL: ACCESS_EMAIL,
    ...overrides,
  };
}

function request(path, init = {}) { return new Request(`https://eat.shoumc.com${path}`, init); }

let accessMaterialPromise;
async function accessMaterial() {
  accessMaterialPromise ??= (async () => {
    const keyPair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    return { privateKey: keyPair.privateKey, publicJwk: { ...publicJwk, kid: 'publication-test-key' } };
  })();
  return accessMaterialPromise;
}

function base64url(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }

async function accessToken() {
  const material = await accessMaterial();
  const header = base64url({ alg: 'RS256', typ: 'JWT', kid: 'publication-test-key' });
  const payload = base64url({ iss: `https://${ACCESS_DOMAIN}`, aud: ACCESS_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, email: ACCESS_EMAIL });
  const input = `${header}.${payload}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', material.privateKey, new TextEncoder().encode(input));
  return { assertion: `${input}.${Buffer.from(signature).toString('base64url')}`, publicJwk: material.publicJwk };
}

async function withAccess(callback) {
  const originalFetch = globalThis.fetch;
  const { assertion, publicJwk } = await accessToken();
  globalThis.fetch = async (input) => {
    assert.equal(String(input), ACCESS_CERTS_URL);
    return new Response(JSON.stringify({ keys: [publicJwk] }), { headers: { 'Content-Type': 'application/json' } });
  };
  try { return await callback(assertion); } finally { globalThis.fetch = originalFetch; }
}

function insertSubmission(database, id, schemaVersion) {
  database.sqlite.prepare('INSERT INTO submissions (id, schema_version) VALUES (?, ?)').run(id, schemaVersion);
}

function insertJob(database, values) {
  database.sqlite.prepare('INSERT INTO publication_jobs (id, submission_id, submission_version, status, branch, pr_number, pr_url, attempts, error_code, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(values.id, values.submissionId, values.version ?? 2, values.status, values.branch ?? `submission/${values.submissionId}`, values.prNumber ?? null, values.prUrl ?? null, values.attempts ?? 0, values.errorCode ?? null, values.createdAt, values.updatedAt);
}

test('v2 publication listing returns only v2 jobs in updated order for the admin UI', async () => {
  const database = createDatabase();
  insertSubmission(database, 'legacy-submission', 1);
  insertSubmission(database, 'v2-submission-old', 2);
  insertSubmission(database, 'v2-submission-new', 2);
  insertJob(database, { id: 'legacy-job', submissionId: 'legacy-submission', status: 'deployed', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z', prUrl: 'https://github.com/legacy/pr/1' });
  insertJob(database, { id: 'v2-job-old', submissionId: 'v2-submission-old', status: 'failed', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z', prUrl: 'https://github.com/v2/pr/1', errorCode: 'export_failed' });
  insertJob(database, { id: 'v2-job-new', submissionId: 'v2-submission-new', status: 'merged_main', createdAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-02T00:00:00Z', prUrl: 'https://github.com/v2/pr/2' });
  const runtime = env(database);
  await withAccess(async (assertion) => {
    const response = await worker.fetch(request('/api/v2/admin/publications', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }), runtime, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    const body = await response.json();
    assert.deepEqual(body.publications.map((job) => [job.id, job.submission_id, job.status, job.pr_url]), [
      ['v2-job-new', 'v2-submission-new', 'merged_main', 'https://github.com/v2/pr/2'],
      ['v2-job-old', 'v2-submission-old', 'failed', 'https://github.com/v2/pr/1'],
    ]);
    assert.equal(database.queryCount, 1);
  });
});

test('v2 publication listing returns an empty list when only legacy jobs exist', async () => {
  const database = createDatabase();
  insertSubmission(database, 'legacy-submission', 1);
  insertJob(database, { id: 'legacy-job', submissionId: 'legacy-submission', status: 'deployed', createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-03T00:00:00Z' });
  const runtime = env(database);
  await withAccess(async (assertion) => {
    const response = await worker.fetch(request('/api/v2/admin/publications', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }), runtime, {});
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
    assert.deepEqual(await response.json(), { publications: [] });
  });
});

test('v2 publication listing requires a verified administrator before querying publication jobs', async () => {
  const database = createDatabase();
  const runtime = env(database);
  const response = await worker.fetch(request('/api/v2/admin/publications'), runtime, {});
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: { code: 'unauthorized', message: '请先登录管理员账号。', loginUrl: '/auth/login?returnTo=%2Fadmin%2F' } });
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(database.queryCount, 0);
});
