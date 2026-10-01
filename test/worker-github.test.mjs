import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createAppJwt, decodeGithubContent, exportApprovedSubmission } from '../src/worker/publication/github.ts';
import { safeErrorCode } from '../src/worker/publication/queue.ts';

test('GitHub App JWT accepts PKCS#1 and PKCS#8 PEM keys without exposing key material', async () => {
  const pkcs1 = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const pkcs8 = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  for (const key of [pkcs1, pkcs8]) {
    const jwt = await createAppJwt('123', key);
    assert.equal(jwt.split('.').length, 3);
    assert.deepEqual(JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url').toString()), { alg: 'RS256', typ: 'JWT' });
    assert.match(jwt, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(jwt, /BEGIN|PRIVATE KEY/);
  }
});

test('decodes GitHub content as UTF-8 instead of treating bytes as Latin-1', () => {
  const content = '餐厅：酸菜鱼';
  const bytes = new TextEncoder().encode(content);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  assert.equal(decodeGithubContent(btoa(binary)), content);
});

test('GitHub API requests include a fixed User-Agent and keep HTTP errors status-only', async () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (input, init) => {
    request = { input: String(input), headers: new Headers(init?.headers) };
    return new Response(JSON.stringify({ message: 'private response details must stay private' }), { status: 401, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await assert.rejects(() => exportApprovedSubmission({ GITHUB_REPOSITORY: 'owner/repository', GITHUB_APP_ID: '123', GITHUB_INSTALLATION_ID: '456', GITHUB_PRIVATE_KEY: privateKey }, {
      jobId: 'job-ua-001', branch: 'submission/job-ua-001', type: 'new', targetId: 'venue-ua', revision: { name: '测试店' }, original: {}, contentHash: 'a'.repeat(64),
    }), (error) => error instanceof Error && error.message === 'github_401');
    assert.equal(request.input, 'https://api.github.com/app/installations/456/access_tokens');
    assert.equal(request.headers.get('User-Agent'), 'shou-food-publisher');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('v2 export builds from the base commit tree while retaining the commit as parent', async () => {
  const privateKey = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey;
  const commitSha = 'c'.repeat(40);
  const treeSha = 't'.repeat(40);
  const createdCommitSha = 'd'.repeat(40);
  const requests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = decodeURIComponent(url.pathname);
    const method = init.method ?? 'GET';
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    requests.push({ url, method, headers, body });
    if (method === 'POST' && url.pathname === '/app/installations/123/access_tokens') return jsonResponse({ token: 'installation-token', expires_at: new Date(Date.now() + 3_600_000).toISOString() });
    if (method === 'GET' && path.endsWith('/git/ref/heads/submission/job-v2-001')) return jsonResponse({}, 404);
    if (method === 'GET' && path.endsWith('/git/ref/heads/dev')) return jsonResponse({ object: { sha: commitSha } });
    if (method === 'GET' && path.endsWith(`/git/commits/${commitSha}`)) return jsonResponse({ tree: { sha: treeSha } });
    if (method === 'POST' && path.endsWith('/git/blobs')) return jsonResponse({ sha: `blob-${requests.length}` });
    if (method === 'POST' && path.endsWith('/git/trees')) return jsonResponse({ sha: 'e'.repeat(40) });
    if (method === 'POST' && path.endsWith('/git/commits')) return jsonResponse({ sha: createdCommitSha });
    if (method === 'POST' && path.endsWith('/git/refs')) return jsonResponse({ ref: 'refs/heads/submission/job-v2-001' });
    if (method === 'POST' && path.endsWith('/pulls')) return jsonResponse({ number: 7, html_url: 'https://github.com/owner/repository/pull/7' });
    throw new Error(`unexpected GitHub request: ${method} ${path}`);
  };
  try {
    const result = await exportApprovedSubmission({ GITHUB_REPOSITORY: 'owner/repository', GITHUB_APP_ID: '123', GITHUB_INSTALLATION_ID: '123', GITHUB_PRIVATE_KEY: privateKey }, {
      jobId: 'job-v2-001', branch: 'submission/job-v2-001', type: 'new', targetId: 'venue-v2', entityType: 'venue', entityId: 'venue-v2', schemaVersion: 2, original: {}, contentHash: 'a'.repeat(64),
      revision: { payload: { name: '测试档口', type: 'stall', campusScope: 'on-campus', location: { address: '校园内', campusArea: null, floor: null, landmark: null, coordinates: null, distanceMeters: null, distanceBasis: null }, averagePrice: null, description: null, openingHours: null, foods: [], tags: [], images: [], sources: [{ repository: 'integration', path: 'fixture.json', revision: 'test', license: null, note: null, sourceUrl: null, collectedAt: null }], dates: { visitedAt: null, verifiedAt: null, updatedAt: null } } },
    });
    assert.deepEqual(result, { number: 7, html_url: 'https://github.com/owner/repository/pull/7' });
    const treeRequest = requests.find((request) => request.url.pathname.endsWith('/git/trees'));
    const commitRequest = requests.find((request) => request.url.pathname.endsWith('/git/commits') && request.method === 'POST');
    assert.ok(treeRequest);
    assert.ok(commitRequest);
    assert.notEqual(commitSha, treeSha);
    assert.equal(treeRequest.body.base_tree, treeSha);
    assert.deepEqual(commitRequest.body.parents, [commitSha]);
    assert.equal(treeRequest.body.tree.length, 2);
    assert.deepEqual(treeRequest.body.tree.map((item) => item.path).sort(), ['.publication-manifest/job-v2-001.json', 'src/content/restaurants/venue-v2.json']);
    assert.ok(requests.every((request) => request.headers.get('User-Agent') === 'shou-food-publisher'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('publication queue preserves safe GitHub status codes without accepting response text', () => {
  for (const status of [401, 403, 404, 422, 429, 500, 502, 503, 504]) assert.equal(safeErrorCode(new Error(`github_${status}`)), `github_${status}`);
  assert.equal(safeErrorCode(new Error('github_401_private_response_details')), 'export_failed');
  assert.equal(safeErrorCode(new Error('unexpected_private_error')), 'export_failed');
});

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
}
