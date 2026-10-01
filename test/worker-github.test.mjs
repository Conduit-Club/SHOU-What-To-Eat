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

test('publication queue preserves safe GitHub status codes without accepting response text', () => {
  for (const status of [401, 403, 404, 422, 429, 500, 502, 503, 504]) assert.equal(safeErrorCode(new Error(`github_${status}`)), `github_${status}`);
  assert.equal(safeErrorCode(new Error('github_401_private_response_details')), 'export_failed');
  assert.equal(safeErrorCode(new Error('unexpected_private_error')), 'export_failed');
});
