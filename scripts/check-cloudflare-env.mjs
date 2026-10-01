import process from 'node:process';

const args = new Set(process.argv.slice(2));
const environment = valueAfter('--environment') ?? 'local';
const includeCallback = args.has('--callback');
const requireApiToken = args.has('--ci') || process.env.CI === 'true';
const publicationEnabled = process.env.PUBLICATION_ENABLED === 'true';
const mediaMode = process.env.MEDIA_MODE?.trim() || (environment === 'local' ? 'external' : 'r2');

if (!['local', 'preview', 'production'].includes(environment)) {
  fail(`未知 Cloudflare 环境：${environment}。可用值为 local、preview、production。`);
}

const required = {
  local: [],
  preview: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PREVIEW_D1_DATABASE_ID'],
  production: ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_D1_DATABASE_ID'],
};

if (requireApiToken && environment !== 'local') required[environment].unshift('CLOUDFLARE_API_TOKEN');

if (environment === 'production' && includeCallback) {
  required.production.push('DEPLOY_WEBHOOK_URL', 'DEPLOY_WEBHOOK_SECRET');
}
if (environment === 'production' && publicationEnabled) {
  required.production.push('PUBLIC_TURNSTILE_SITE_KEY');
}
if (environment !== 'local' && mediaMode === 'r2' && publicationEnabled) {
  required[environment].push(environment === 'production' ? 'CLOUDFLARE_R2_BUCKET_NAME' : 'CLOUDFLARE_PREVIEW_R2_BUCKET_NAME');
}

const missing = required[environment].filter((name) => !process.env[name]?.trim());
if (missing.length) {
  fail(`Cloudflare ${environment} 部署配置不完整。缺少环境变量：${missing.join(', ')}`);
}

if (environment !== 'local') {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const databaseId = environment === 'production' ? process.env.CLOUDFLARE_D1_DATABASE_ID : process.env.CLOUDFLARE_PREVIEW_D1_DATABASE_ID;
  if (!/^[a-f0-9]{32}$/i.test(accountId)) fail('CLOUDFLARE_ACCOUNT_ID 必须是 32 位十六进制 Cloudflare Account ID。');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(databaseId)) fail(`Cloudflare ${environment} D1 database ID 格式无效。`);
  if (includeCallback) {
    if (!isHttpsUrl(process.env.DEPLOY_WEBHOOK_URL)) fail('DEPLOY_WEBHOOK_URL 必须使用 HTTPS。');
  }
  if (environment === 'production' && publicationEnabled && isPlaceholder(process.env.PUBLIC_TURNSTILE_SITE_KEY)) {
    fail('PUBLIC_TURNSTILE_SITE_KEY 必须是非空且非占位值的 Turnstile 公钥。');
  }
  if (!['external', 'r2'].includes(mediaMode)) fail('MEDIA_MODE 必须是 external 或 r2。');
}

process.stdout.write(`Cloudflare ${environment} deployment environment is configured.\n`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isHttpsUrl(value) {
  try {
    const url = new URL(value ?? '');
    return url.protocol === 'https:' && Boolean(url.hostname);
  } catch {
    return false;
  }
}

function isPlaceholder(value) {
  const normalized = value?.trim().toLowerCase() ?? '';
  return !normalized || /(?:replace[-_ ]?with|your[-_ ]|placeholder|example|changeme|<[^>]+>)/i.test(normalized);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
