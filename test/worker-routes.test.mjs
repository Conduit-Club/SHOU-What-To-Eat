import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import worker from '../src/worker/index.ts';

function env(overrides = {}) {
  return {
    DB: createDatabase(),
    ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) },
    MEDIA_MODE: 'external',
    ALLOWED_ORIGINS: 'http://localhost:4321',
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    LEGACY_SUBMISSIONS_ENABLED: 'true',
    TURNSTILE_HOSTNAME: 'eat.shoumc.com',
    ACCESS_TEAM_DOMAIN: 'team.example.cloudflareaccess.com',
    ACCESS_AUD: 'access-audience',
    ACCESS_REVIEWER_EMAIL: 'reviewer@example.com',
    GITHUB_APP_ID: '123',
    GITHUB_PRIVATE_KEY: 'private-key',
    GITHUB_INSTALLATION_ID: '123',
    GITHUB_REPOSITORY: 'owner/repository',
    GITHUB_WEBHOOK_SECRET: 'github-secret',
    DEPLOY_WEBHOOK_SECRET: 'deploy-secret',
    ...overrides,
  };
}

test('static requests and catalog health stay available while full mode reports missing config', async () => {
  const staticResponse = await worker.fetch(new Request('https://eat.shoumc.com/'), env({ TURNSTILE_SECRET_KEY: '' }), {});
  assert.equal(staticResponse.status, 200);
  const health = await worker.fetch(new Request('https://eat.shoumc.com/api/health'), env({ TURNSTILE_SECRET_KEY: '' }), {});
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok', mode: 'catalog-only' });
  const fullHealth = await worker.fetch(new Request('https://eat.shoumc.com/api/health'), env({ PUBLICATION_ENABLED: 'true', GITHUB_INSTALLATION_ID: '' }), {});
  assert.equal(fullHealth.status, 503);
  assert.deepEqual(await fullHealth.json(), { status: 'unavailable', mode: 'full' });
});

test('catalog-only mode closes submissions, receipts, admin, and webhooks even with residual secrets', async () => {
  const runtime = env();
  const submission = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/submissions', { method: 'POST', body: '{}' }), runtime, {});
  assert.equal(submission.status, 503);
  assert.equal((await submission.json()).error.code, 'service_unavailable');
  const receipt = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/submissions/id/status', { headers: { Authorization: 'Bearer leftover-token' } }), runtime, {});
  assert.equal(receipt.status, 503);
  const admin = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/admin/submissions', { headers: { 'Cf-Access-Jwt-Assertion': 'access-assertion' } }), runtime, {});
  assert.equal(admin.status, 503);
  const webhook = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/webhooks/deploy', { method: 'POST', body: '{}' }), runtime, {});
  assert.equal(webhook.status, 503);
  assert.equal(webhook.headers.get('Cache-Control'), 'no-store');
});

test('unknown APIs return a cacheless JSON 404 and admin rejects missing Access JWT', async () => {
  const runtime = env();
  const apiRoot = await worker.fetch(new Request('https://eat.shoumc.com/api'), runtime, {});
  assert.equal(apiRoot.status, 404);
  assert.equal(apiRoot.headers.get('Cache-Control'), 'no-store');
  assert.equal((await apiRoot.json()).error.code, 'not_found');
  const unknown = await worker.fetch(new Request('https://eat.shoumc.com/api/unknown'), runtime, {});
  assert.equal(unknown.status, 404);
  assert.equal(unknown.headers.get('Cache-Control'), 'no-store');
  assert.equal((await unknown.json()).error.code, 'not_found');
  const admin = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/admin/submissions'), runtime, {});
  assert.equal(admin.status, 401);
  assert.equal((await admin.json()).error.code, 'unauthorized');
});

test('idempotency prevents a second submission and conflicts on changed content', async () => {
  const originalFetch = globalThis.fetch;
  let turnstileCalls = 0;
  globalThis.fetch = async (input) => {
    if (String(input).includes('challenges.cloudflare.com/turnstile')) { turnstileCalls += 1; return new Response(JSON.stringify({ success: true, action: 'submission', hostname: 'eat.shoumc.com' }), { status: 200, headers: { 'Content-Type': 'application/json' } }); }
    return originalFetch(input);
  };
  try {
    const runtime = env({ PUBLICATION_ENABLED: 'true' });
    const payload = { kind: 'review', targetId: 'first-canteen', name: '一食堂', location: '一楼窗口', body: '牛肉面好吃', category: 'on-campus', turnstileToken: 'valid-token' };
    const first = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idempotency-key-001' }, body: JSON.stringify(payload) }), runtime, {});
    assert.equal(first.status, 202);
    assert.ok((await first.json()).receiptToken);
    const replay = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idempotency-key-001' }, body: JSON.stringify(payload) }), runtime, {});
    assert.equal(replay.status, 409);
    assert.equal((await replay.json()).error.code, 'idempotency_replayed');
    const conflict = await worker.fetch(new Request('https://eat.shoumc.com/api/v1/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'idempotency-key-001' }, body: JSON.stringify({ ...payload, body: '换一份内容' }) }), runtime, {});
    assert.equal(conflict.status, 409);
    assert.equal((await conflict.json()).error.code, 'idempotency_conflict');
    assert.equal(turnstileCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function createDatabase() {
  const submissions = new Map();
  const idempotency = new Map();
  let requestCount = 0;
  return {
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('SELECT submission_id, request_hash')) return idempotency.get(values[0]) ?? null;
              if (sql.includes('SELECT request_count')) return requestCount ? { request_count: requestCount } : null;
              if (sql.includes('SELECT id, status')) return submissions.get(values[0]) ?? null;
              return null;
            },
            async run() {
              if (sql.includes('INSERT INTO submissions')) submissions.set(values[0], { id: values[0], status: 'pending', created_at: values[6], updated_at: values[7] });
              if (sql.includes('INSERT INTO submission_idempotency')) idempotency.set(values[0], { submission_id: values[1], request_hash: values[2] });
              if (sql.includes('INSERT INTO rate_limits')) requestCount += 1;
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      for (const statement of statements) await statement.run();
      return statements.map(() => ({ meta: { changes: 1 } }));
    },
  };
}

test('D1 migrations preserve submission audit and idempotency constraints', async () => {
  const initial = await readFile(new URL('../migrations/0001_initial.sql', import.meta.url), 'utf8');
  const idempotency = await readFile(new URL('../migrations/0002_submission_idempotency.sql', import.meta.url), 'utf8');
  const audit = await readFile(new URL('../migrations/0003_audit_submission_action.sql', import.meta.url), 'utf8');
  const catalog = await readFile(new URL('../migrations/0004_catalog_v2.sql', import.meta.url), 'utf8');
  const media = await readFile(new URL('../migrations/0005_r2_media_quota.sql', import.meta.url), 'utf8');
  const retrySafety = await readFile(new URL('../migrations/0006_publication_retry_safety.sql', import.meta.url), 'utf8');
  assert.match(initial, /'submit'/);
  assert.match(idempotency, /key_hash TEXT PRIMARY KEY/);
  assert.match(idempotency, /request_hash TEXT NOT NULL/);
  assert.match(audit, /ALTER TABLE audit_events_v2 RENAME TO audit_events/);
  assert.doesNotMatch(catalog, /PRAGMA\s+foreign_keys\s*=\s*OFF/i);
  assert.match(catalog, /average_price_min INTEGER/);
  assert.match(catalog, /food_meal_types/);
  assert.match(catalog, /content_hash TEXT NOT NULL/);
  assert.match(catalog, /metadata_json TEXT NOT NULL/);
  assert.match(media, /media_reservations/);
  assert.match(media, /media_upload_attempts/);
  assert.match(media, /OLD\.object_state <> 'deleted'/);
  assert.match(retrySafety, /job_id TEXT NOT NULL/);
  assert.match(retrySafety, /status TEXT NOT NULL DEFAULT 'completed'/);
  assert.match(retrySafety, /status TEXT NOT NULL DEFAULT 'processed'/);
  assert.match(retrySafety, /source_note TEXT/);
  assert.match(retrySafety, /write_operation_id TEXT/);
  assert.match(await readFile(new URL('../src/worker/routes/webhooks.ts', import.meta.url), 'utf8'), /catalog_mirror/);
  assert.match(await readFile(new URL('../src/worker/routes/admin-v2.ts', import.meta.url), 'utf8'), /write_operation_id/);
});
