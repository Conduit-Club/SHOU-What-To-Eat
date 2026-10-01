import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const checker = path.join(repositoryRoot, 'scripts', 'check-cloudflare-env.mjs');

test('production publication mode accepts a real-looking Turnstile key and HTTPS callback', () => {
  const result = runProduction();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Cloudflare production deployment environment is configured/);
});

test('production publication mode rejects a missing or placeholder Turnstile key', () => {
  const missing = runProduction({ PUBLIC_TURNSTILE_SITE_KEY: '' });
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /PUBLIC_TURNSTILE_SITE_KEY/);

  const placeholder = runProduction({ PUBLIC_TURNSTILE_SITE_KEY: 'replace-with-public-turnstile-site-key' });
  assert.notEqual(placeholder.status, 0);
  assert.match(placeholder.stderr, /非空且非占位/);
});

test('live publication does not depend on the retired deployment callback', () => {
  const result = runProduction({ DEPLOY_WEBHOOK_URL: 'http://eat.shoumc.com/api/v1/webhooks/deploy' });
  assert.equal(result.status, 0, result.stderr);
});

test('catalog-only production mode does not require publication credentials', () => {
  const result = runProduction({
    PUBLICATION_ENABLED: 'false',
    PUBLIC_TURNSTILE_SITE_KEY: '',
    DEPLOY_WEBHOOK_URL: '',
    DEPLOY_WEBHOOK_SECRET: '',
  });
  assert.equal(result.status, 0, result.stderr);
});

function runProduction(overrides = {}) {
  const env = {
    ...process.env,
    CI: 'true',
    CLOUDFLARE_API_TOKEN: 'test-token',
    CLOUDFLARE_ACCOUNT_ID: 'a'.repeat(32),
    CLOUDFLARE_D1_DATABASE_ID: '11111111-1111-4111-8111-111111111111',
    DEPLOY_WEBHOOK_URL: 'https://eat.shoumc.com/api/v1/webhooks/deploy',
    DEPLOY_WEBHOOK_SECRET: 'test-secret',
    MEDIA_MODE: 'external',
    PUBLICATION_ENABLED: 'true',
    PUBLIC_TURNSTILE_SITE_KEY: '0xvalid-public-site-key',
    ...overrides,
  };
  return spawnSync(process.execPath, [checker, '--environment', 'production', '--ci'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env,
  });
}
