import { createHmac } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);

const callbackUrl = required('DEPLOY_WEBHOOK_URL');
const secret = required('DEPLOY_WEBHOOK_SECRET');
const repository = required('GITHUB_REPOSITORY');
const commit = required('GITHUB_SHA');
if (!/^[0-9a-f]{40}$/i.test(commit)) fail('GITHUB_SHA 必须是完整 40 位提交号。');

const root = '.publication-manifest';
let allNames = [];
try { allNames = (await readdir(root)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name)).sort(); } catch (error) {
  if (error?.code === 'ENOENT') { process.stdout.write('没有待回调的发布清单。\n'); process.exit(0); }
  throw error;
}
const names = await changedManifestNames(root, allNames);
if (!names.length) { process.stdout.write('当前部署提交没有新增发布清单。\n'); process.exit(0); }
for (const name of names) {
  const manifest = JSON.parse(await readFile(join(root, name), 'utf8'));
  if (typeof manifest.jobId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(manifest.jobId) || typeof manifest.contentHash !== 'string' || !/^[0-9a-f]{64}$/i.test(manifest.contentHash)) fail(`发布清单 ${name} 的任务号或内容哈希无效。`);
  const body = JSON.stringify({ repository, commit: commit.toLowerCase(), contentHash: manifest.contentHash.toLowerCase(), jobId: manifest.jobId });
  const signature = `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
  const response = await fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Deploy-Signature': signature }, body });
  if (!response.ok) fail(`部署回调失败（HTTP ${response.status}）。`);
  process.stdout.write(`已回调 ${name}。\n`);
}

async function changedManifestNames(directory, available) {
  const before = process.env.GITHUB_EVENT_BEFORE;
  const after = process.env.GITHUB_SHA;
  const base = before && !/^0+$/.test(before) ? before : 'HEAD^';
  try {
    const result = await execFile('git', ['diff', '--name-only', '--diff-filter=AM', base, after || 'HEAD', '--', `${directory}/`], { encoding: 'utf8' });
    const prefix = `${directory}/`;
    const names = result.stdout.split(/\r?\n/).filter(Boolean).filter((path) => path.startsWith(prefix)).map((path) => path.slice(prefix.length)).filter((name) => /^[A-Za-z0-9_-]+\.json$/.test(name));
    return names.filter((name, index) => names.indexOf(name) === index).sort();
  } catch {
    // A shallow checkout cannot prove which manifest is new. Failing closed
    // avoids replaying every historical submission against a new commit.
    fail('无法确定当前提交中的发布清单；请使用至少两层 Git checkout。');
    return [];
  }
}

function required(name) { const value = process.env[name]?.trim(); if (!value) fail(`缺少 ${name}。`); return value; }
function fail(message) { process.stderr.write(`${message}\n`); process.exit(1); }
