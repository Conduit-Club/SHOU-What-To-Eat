import { readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const environment = valueAfter('--environment') ?? 'local';
const checkOnly = process.argv.includes('--check');
if (!['local', 'preview', 'production'].includes(environment)) {
  fail(`未知 Cloudflare 环境：${environment}。可用值为 local、preview、production。`);
}

const accountId = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
const databaseId = environment === 'production'
  ? process.env.CLOUDFLARE_D1_DATABASE_ID?.trim()
  : environment === 'preview'
    ? process.env.CLOUDFLARE_PREVIEW_D1_DATABASE_ID?.trim()
    : '00000000-0000-0000-0000-000000000001';

if (environment !== 'local') {
  if (!accountId || !/^[a-f0-9]{32}$/i.test(accountId)) fail('请设置有效的 CLOUDFLARE_ACCOUNT_ID（32 位十六进制 Account ID）。');
  if (!databaseId || !isUuid(databaseId)) fail(`请设置有效的 ${environment === 'production' ? 'CLOUDFLARE_D1_DATABASE_ID' : 'CLOUDFLARE_PREVIEW_D1_DATABASE_ID'}。`);
}

const isProduction = environment === 'production';
const publicationEnabled = isProduction && process.env.PUBLICATION_ENABLED === 'true';
// Wrangler resolves script, assets, migration, and tsconfig paths from the
// invocation directory. Keep these paths project-relative even though the
// generated file itself is ignored by git.
const projectPath = '';
const sourceText = await readFile('wrangler.jsonc', 'utf8');
const source = JSON.parse(sourceText.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''));
const selected = environment === 'local' ? {} : source.env?.[environment];
if (environment !== 'local' && !selected) fail(`wrangler.jsonc 未定义 ${environment} 环境。`);
const configuredVars = selected?.vars ?? source.vars;
const mediaMode = process.env.MEDIA_MODE?.trim() || configuredVars.MEDIA_MODE || (environment === 'local' ? 'external' : 'r2');
if (!['external', 'r2'].includes(mediaMode)) fail('MEDIA_MODE 必须是 external 或 r2。');
const bucketName = environment === 'production'
  ? process.env.CLOUDFLARE_R2_BUCKET_NAME?.trim()
  : environment === 'preview'
    ? process.env.CLOUDFLARE_PREVIEW_R2_BUCKET_NAME?.trim()
    : process.env.CLOUDFLARE_R2_BUCKET_NAME?.trim();
if (mediaMode === 'r2' && publicationEnabled && !bucketName) fail(`PUBLICATION_ENABLED=true 时必须设置 ${environment === 'production' ? 'CLOUDFLARE_R2_BUCKET_NAME' : 'CLOUDFLARE_PREVIEW_R2_BUCKET_NAME'}。`);

const config = {
  ...source,
  ...selected,
  $schema: `${projectPath}node_modules/wrangler/config-schema.json`,
  main: `${projectPath}src/worker/index.ts`,
  tsconfig: `${projectPath}src/worker/tsconfig.json`,
  ...(accountId ? { account_id: accountId } : {}),
  d1_databases: [{
    ...(selected?.d1_databases?.[0] ?? source.d1_databases[0]),
    database_id: databaseId,
    migrations_dir: `${projectPath}migrations`,
  }],
  ...(mediaMode === 'r2' && bucketName ? { r2_buckets: [{ binding: 'IMAGES', bucket_name: bucketName }] } : mediaMode === 'r2' ? { r2_buckets: [] } : {}),
  assets: {
    ...(selected?.assets ?? source.assets),
    directory: `${projectPath}dist`,
  },
  vars: {
    ...configuredVars,
    MEDIA_MODE: mediaMode,
    ...(process.env.TURNSTILE_HOSTNAME?.trim() ? { TURNSTILE_HOSTNAME: process.env.TURNSTILE_HOSTNAME.trim() } : {}),
    ...(process.env.PUBLIC_TURNSTILE_SITE_KEY?.trim() ? { PUBLIC_TURNSTILE_SITE_KEY: process.env.PUBLIC_TURNSTILE_SITE_KEY.trim() } : {}),
    PUBLICATION_ENABLED: publicationEnabled ? 'true' : 'false',
  },
  triggers: { crons: publicationEnabled ? ['*/2 * * * *'] : [] },
};
delete config.env;

if (checkOnly) {
  process.stdout.write(`Wrangler ${environment} configuration can be generated without writing credentials.\n`);
  process.exit(0);
}

const outputPath = `wrangler.generated.${environment}.jsonc`;
await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
process.stdout.write(`Generated ignored Wrangler configuration for ${environment}: ${outputPath}\n`);

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

function isUuid(value) {
  return /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}
