import test from 'node:test';
import assert from 'node:assert/strict';
import worker from '../src/worker/index.ts';

const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ACCESS_DOMAIN = 'team.example.cloudflareaccess.com';
const ACCESS_AUDIENCE = 'access-audience';

function env(overrides = {}) {
  return {
    DB: createDatabase(),
    ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) },
    MEDIA_MODE: 'external',
    ALLOWED_ORIGINS: 'http://localhost:4321',
    PUBLICATION_ENABLED: 'true',
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    ACCESS_TEAM_DOMAIN: ACCESS_DOMAIN,
    ACCESS_AUD: ACCESS_AUDIENCE,
    GITHUB_APP_ID: '123',
    GITHUB_PRIVATE_KEY: 'private-key',
    GITHUB_INSTALLATION_ID: '123',
    GITHUB_REPOSITORY: 'owner/repository',
    GITHUB_WEBHOOK_SECRET: 'github-secret',
    DEPLOY_WEBHOOK_SECRET: 'deploy-secret',
    ...overrides,
  };
}

function request(path, init = {}) {
  return new Request(`https://eat.shoumc.com${path}`, init);
}

function submissionPayload(overrides = {}) {
  return {
    kind: 'review',
    targetId: 'first-canteen',
    name: '一食堂',
    location: '一楼窗口',
    body: '牛肉面好吃',
    category: 'on-campus',
    turnstileToken: 'turnstile-token',
    ...overrides,
  };
}

async function postSubmission(runtime, payload = submissionPayload(), init = {}) {
  return worker.fetch(request('/api/v1/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: JSON.stringify(payload),
    ...init,
  }), runtime, {});
}

async function withFetchStub(stub, callback) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = stub;
  try {
    return await callback();
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function turnstileResponse(success) {
  return new Response(JSON.stringify({ success }), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

test('rejects a streamed request over 64 KiB without Content-Length before external verification', async () => {
  const runtime = env();
  let turnstileCalls = 0;
  const chunks = [new Uint8Array(40 * 1024), new Uint8Array(40 * 1024)];
  let nextChunk = 0;
  const body = new ReadableStream({
    pull(controller) {
      if (nextChunk < chunks.length) controller.enqueue(chunks[nextChunk++]);
      else controller.close();
    },
  });
  const streamed = request('/api/v1/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, duplex: 'half' });
  assert.equal(streamed.headers.get('Content-Length'), null);

  const response = await withFetchStub(async (input) => {
    if (String(input) === TURNSTILE_URL) turnstileCalls += 1;
    throw new Error('unexpected external call');
  }, () => worker.fetch(streamed, runtime, {}));

  assert.equal(response.status, 413);
  assert.equal((await response.json()).error.code, 'request_too_large');
  assert.equal(turnstileCalls, 0);
  assert.equal(runtime.DB._submissions.size, 0);
});

test('rejects overlong submission fields before Turnstile and persistence', async () => {
  const cases = [
    ['name', 'x'.repeat(101)],
    ['location', 'x'.repeat(301)],
    ['body', 'x'.repeat(20_001)],
  ];

  for (const [field, value] of cases) {
    const runtime = env();
    let externalCalls = 0;
    const response = await withFetchStub(async () => {
      externalCalls += 1;
      throw new Error('Turnstile must not run for invalid content');
    }, () => postSubmission(runtime, submissionPayload({ [field]: value })));

    assert.equal(response.status, 422, field);
    assert.equal((await response.json()).error.code, 'content_too_long', field);
    assert.equal(externalCalls, 0, field);
    assert.equal(runtime.DB._submissions.size, 0, field);
  }
});

test('does not persist or expose data when Turnstile rejects the submission', async () => {
  const runtime = env();
  let calls = 0;
  const response = await withFetchStub(async (input) => {
    assert.equal(String(input), TURNSTILE_URL);
    calls += 1;
    return turnstileResponse(false);
  }, () => postSubmission(runtime));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'challenge_failed');
  assert.equal(calls, 1);
  assert.equal(runtime.DB._submissions.size, 0);
  assert.doesNotMatch(JSON.stringify(body), /turnstile-token|original_json|revision_json|receiptToken/);
});

test('treats Turnstile network failure as a generic challenge failure', async () => {
  const runtime = env();
  const response = await withFetchStub(async (input) => {
    assert.equal(String(input), TURNSTILE_URL);
    throw new Error('network unavailable');
  }, () => postSubmission(runtime));
  const body = await response.json();

  assert.equal(response.status, 400);
  assert.equal(body.error.code, 'challenge_failed');
  assert.equal(runtime.DB._submissions.size, 0);
  assert.doesNotMatch(JSON.stringify(body), /network unavailable|turnstile-token|receiptToken/);
});

test('status lookup requires the matching receipt token and never returns private fields', async () => {
  const runtime = env();
  const response = await withFetchStub(async (input) => {
    assert.equal(String(input), TURNSTILE_URL);
    return turnstileResponse(true);
  }, () => postSubmission(runtime));
  assert.equal(response.status, 202);
  const created = await response.json();
  assert.ok(created.id);
  assert.ok(created.receiptToken);

  const correct = await worker.fetch(request(`/api/v1/submissions/${created.id}/status`, { headers: { Authorization: `Bearer ${created.receiptToken}` } }), runtime, {});
  assert.equal(correct.status, 200);
  const status = await correct.json();
  assert.deepEqual(Object.keys(status).sort(), ['createdAt', 'id', 'status', 'updatedAt'].sort());
  assert.equal(status.id, created.id);
  assert.equal(status.status, 'pending');
  assert.doesNotMatch(JSON.stringify(status), new RegExp(created.receiptToken));
  assert.doesNotMatch(JSON.stringify(status), /receipt_hash|original_json|revision_json/);

  const wrong = await worker.fetch(request(`/api/v1/submissions/${created.id}/status`, { headers: { Authorization: 'Bearer wrong-receipt-token' } }), runtime, {});
  assert.equal(wrong.status, 404);
  const wrongBody = await wrong.json();
  assert.equal(wrongBody.error.code, 'not_found');
  assert.doesNotMatch(JSON.stringify(wrongBody), /receiptToken|receipt_hash|original_json|revision_json|turnstile-token/);
});

let accessMaterialPromise;
async function accessMaterial() {
  accessMaterialPromise ??= (async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    return { privateKey: keyPair.privateKey, publicJwk: { ...publicJwk, alg: 'RS256', kid: 'test-access-key', use: 'sig' } };
  })();
  return accessMaterialPromise;
}

function encodeBase64Url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

async function signedAccessJwt(claims, tamperSignature = false) {
  const material = await accessMaterial();
  const header = encodeBase64Url({ alg: 'RS256', typ: 'JWT', kid: 'test-access-key' });
  const payload = encodeBase64Url(claims);
  const input = `${header}.${payload}`;
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', material.privateKey, new TextEncoder().encode(input)));
  if (tamperSignature) signature[0] ^= 0xff;
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function accessFetch(publicJwk) {
  return async (input) => {
    assert.equal(String(input), `https://${ACCESS_DOMAIN}/cdn-cgi/access/certs`);
    return new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
}

test('admin read accepts a correctly signed Access JWT and rejects invalid claims', async () => {
  const material = await accessMaterial();
  const issuer = `https://${ACCESS_DOMAIN}`;
  const baseClaims = { iss: issuer, aud: ACCESS_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, email: 'reviewer@example.com' };
  const cases = [
    ['valid', baseClaims, false, 200],
    ['wrong signature', baseClaims, true, 401],
    ['expired', { ...baseClaims, exp: Math.floor(Date.now() / 1000) - 1 }, false, 401],
    ['wrong audience', { ...baseClaims, aud: 'other-audience' }, false, 401],
    ['wrong issuer', { ...baseClaims, iss: 'https://other.example.com' }, false, 401],
    ['missing email', { ...baseClaims, email: undefined }, false, 401],
  ];

  for (const [label, claims, tamper, expectedStatus] of cases) {
    const runtime = env();
    const tokenClaims = { ...claims };
    if (tokenClaims.email === undefined) delete tokenClaims.email;
    const assertion = await signedAccessJwt(tokenClaims, tamper);
    const response = await withFetchStub(accessFetch(material.publicJwk), () => worker.fetch(request('/api/v1/admin/submissions?status=pending', { headers: { 'Cf-Access-Jwt-Assertion': assertion } }), runtime, {}));

    assert.equal(response.status, expectedStatus, label);
    const body = await response.json();
    if (expectedStatus === 200) {
      assert.deepEqual(body.submissions, [], label);
      assert.equal(response.headers.get('Cache-Control'), 'no-store', label);
    } else {
      assert.equal(body.error.code, 'unauthorized', label);
      assert.doesNotMatch(JSON.stringify(body), /original_json|revision_json|receipt_hash|reviewer@example.com/);
    }
  }
});

function createDatabase() {
  const submissions = new Map();
  const database = {
    _submissions: submissions,
    prepare(sql) {
      return {
        bind(...values) {
          return {
            async first() {
              if (sql.includes('SELECT request_count')) return null;
              if (sql.includes('SELECT id, status, created_at, updated_at, receipt_hash FROM submissions')) {
                const row = submissions.get(values[0]);
                if (!row || row.receipt_hash !== values[1]) return null;
                return { id: row.id, status: row.status, created_at: row.created_at, updated_at: row.updated_at };
              }
              return null;
            },
            async all() {
              if (sql.includes('FROM submissions WHERE status = ?')) {
                const [status, cursor, limit] = values;
                return { results: [...submissions.values()].filter((row) => row.status === status && row.id > cursor).sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit) };
              }
              return { results: [] };
            },
            async run() {
              if (sql.includes('INSERT INTO submissions')) {
                const [id, type, targetRestaurantId, originalJson, revisionJson, receiptHash, createdAt, updatedAt] = values;
                submissions.set(id, { id, type, target_restaurant_id: targetRestaurantId, original_json: originalJson, revision_json: revisionJson, receipt_hash: receiptHash, status: 'pending', version: 1, created_at: createdAt, updated_at: updatedAt });
              }
              return { meta: { changes: 1 } };
            },
          };
        },
      };
    },
    async batch(statements) {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
  return database;
}
