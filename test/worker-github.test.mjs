import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createAppJwt, decodeGithubContent } from '../src/worker/publication/github.ts';

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
