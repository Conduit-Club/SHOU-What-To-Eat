import type { AppEnv } from '../types.js';

type Publication = { jobId: string; branch: string; type: string; targetId: string | null; revision: Record<string, unknown>; original: Record<string, unknown>; contentHash: string };
type GitHubResponse<T> = T & { html_url?: string; number?: number };

export async function exportApprovedSubmission(env: AppEnv['Bindings'], publication: Publication): Promise<GitHubResponse<{ number: number; html_url: string }>> {
  const [owner, repo] = env.GITHUB_REPOSITORY.split('/');
  if (!owner || !repo || env.GITHUB_REPOSITORY.split('/').length !== 2) throw new Error('invalid_github_repository');
  const installationToken = await createInstallationToken(env, repo);
  const branch = publication.branch;
  const existing = await github(`/repos/${owner}/${repo}/git/ref/heads/${encodeURIComponent(branch)}`, installationToken, true);
  if (existing && 'object' in existing) {
    const openPulls = await github(`/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&state=open`, installationToken) as { number: number; html_url: string }[];
    if (openPulls.length) return { number: openPulls[0].number, html_url: openPulls[0].html_url };
    throw new Error('publication_branch_exists_without_open_pr');
  }
  const base = await github(`/repos/${owner}/${repo}/git/ref/heads/dev`, installationToken) as { object: { sha: string } };
  const nameSlug = String(publication.revision.name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'restaurant';
  const slug = `${publication.targetId ?? nameSlug}-${publication.jobId.slice(0, 8)}`;
  const newId = publication.targetId ?? slug;
  const snapshot = publication.type === 'new' ? newRecord(newId, publication.revision, publication.contentHash) : { ...publication.revision, id: newId, contentHash: publication.contentHash };
  const detailFile = `src/content/restaurants/${newId}.json`;
  const files: Record<string, string> = { [detailFile]: `${JSON.stringify(snapshot, null, 2)}\n` };
  if (publication.type !== 'new') {
    const existingFile = await github(`/repos/${owner}/${repo}/contents/${encodeURIComponent(detailFile)}?ref=dev`, installationToken) as { content?: string; encoding?: string };
    if (!existingFile.content || existingFile.encoding !== 'base64') throw new Error('target_restaurant_not_found');
    const current = JSON.parse(atob(existingFile.content.replace(/\n/g, '')));
    if (publication.type === 'review') current.reviews = [...(current.reviews ?? []), { text: String(publication.revision.body), author: '匿名同学' }];
    if (publication.type === 'correction') Object.assign(current, snapshot);
    if (current.id !== newId) throw new Error('target_id_mismatch');
    files[detailFile] = `${JSON.stringify(current, null, 2)}\n`;
  }
  const markdown = [`# ${String(publication.revision.name)}`, '', '## 位置', '', String(publication.revision.location), '', '## 消费范围', '', String(publication.revision.price ?? '待补充。'), '', '## 注意事项', '', String(publication.revision.openingHours ?? '营业情况可能变化，请以现场信息为准。'), '', '## 同学评价', '', `> ${String(publication.revision.body).replace(/\n/g, '\n> ')}`, '>', '> —— 匿名同学', ''].join('\n');
  const markdownBlob = await github(`/repos/${owner}/${repo}/git/blobs`, installationToken, false, { content: markdown, encoding: 'utf-8' }) as { sha: string };
  files[`src/content/markdown/${newId}.md`] = markdown;
  const treeItems = await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const blob = path.endsWith('.md') ? markdownBlob : await github(`/repos/${owner}/${repo}/git/blobs`, installationToken, false, { content, encoding: 'utf-8' }) as { sha: string };
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const tree = await github(`/repos/${owner}/${repo}/git/trees`, installationToken, false, { base_tree: base.object.sha, tree: treeItems }) as { sha: string };
  const commit = await github(`/repos/${owner}/${repo}/git/commits`, installationToken, false, { message: `content: ${publication.type} ${newId}`, tree: tree.sha, parents: [base.object.sha] }) as { sha: string };
  await github(`/repos/${owner}/${repo}/git/refs`, installationToken, false, { ref: `refs/heads/${branch}`, sha: commit.sha });
  return github(`/repos/${owner}/${repo}/pulls`, installationToken, false, { title: `餐饮信息：${String(publication.revision.name)}`, body: `审核通过的投稿版本：${publication.contentHash}\n\n- 投稿类型：${publication.type}\n- 目标餐厅：${newId}\n- 审核原稿摘要：${String(publication.original.name ?? '')}\n- 确认评价与图片来源、许可后再合并。`, head: branch, base: 'dev' }, 'POST') as Promise<GitHubResponse<{ number: number; html_url: string }>>;
}

function newRecord(id: string, revision: Record<string, unknown>, contentHash: string) { return { id, name: revision.name, category: revision.category, kind: '餐厅', aliases: [], relatedRestaurantIds: [], location: revision.location, coordinates: null, price: '待核验。', openingHours: null, foods: [], reviews: [{ text: revision.body, author: '匿名同学' }], body: '由投稿审核员整理；补充实际价格与用餐日期后更新。', images: revision.imageUrl ? [{ url: revision.imageUrl, alt: String(revision.name), source: '投稿外链；授权状态需由审核员核对。', permission: 'external' }] : [], sources: [{ repository: 'anonymous-submission', path: contentHash, revision: contentHash, license: null }], visitedAt: revision.visitedAt ?? null, verifiedAt: null, updatedAt: new Date().toISOString().slice(0, 10) }; }

async function createInstallationToken(env: AppEnv['Bindings'], repo: string) {
  const jwt = await appJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
  const installationId = Number(env.GITHUB_INSTALLATION_ID);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('invalid_github_installation_id');
  const token = await github(`/app/installations/${installationId}/access_tokens`, jwt, false, { repositories: [repo], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }, 'POST') as { token: string; expires_at: string };
  if (Date.parse(token.expires_at) < Date.now()) throw new Error('github_token_expired');
  return token.token;
}

async function appJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const head = encode({ alg: 'RS256', typ: 'JWT' }); const payload = encode({ iat: now - 30, exp: now + 540, iss: appId }); const input = `${head}.${payload}`;
  const pem = privateKey.replace(/\\n/g, '\n').replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, '');
  const key = await crypto.subtle.importKey('pkcs8', Uint8Array.from(atob(pem), (char) => char.charCodeAt(0)), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${input}.${signature}`;
}

async function github(path: string, token: string, allowMissing = false, body?: unknown, method = body ? 'POST' : 'GET'): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (allowMissing && response.status === 404) return null;
  const result = await response.json().catch(() => ({})) as { message?: unknown };
  if (!response.ok) throw new Error(`github_${response.status}_${String(result.message ?? 'api_error').replace(/\s+/g, '_').slice(0, 50)}`);
  return result;
}
