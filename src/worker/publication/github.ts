import { parseManaged, validateManagedEdit, validateManagedRelations, type ManagedType, type ManagedRecord } from '../../lib/catalog/management.js';
import type { AppEnv } from '../types.js';
import { foodSchema, reviewSchema, venueSchema, deriveDistanceTags } from '../../lib/catalog/index.js';
import { publicAvatar } from '../../utils/review-identity.js';

export type Publication = { jobId: string; branch: string; type: string; targetId: string | null; revision: Record<string, unknown>; original: Record<string, unknown>; contentHash: string; schemaVersion?: number; entityType?: string | null; entityId?: string | null; parentEntityId?: string | null; submissionId?: string; createdAt?: string };
type GitHubResponse<T> = T & { html_url?: string; number?: number };

export async function exportApprovedSubmission(env: AppEnv['Bindings'], publication: Publication): Promise<GitHubResponse<{ number: number; html_url: string }>> {
  if (publication.entityType === 'management') return exportManagedEdit(env, publication);
  if (publication.schemaVersion === 2 || publication.entityType) return exportV2Submission(env, publication);
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
  const baseCommit = await github(`/repos/${owner}/${repo}/git/commits/${encodeURIComponent(base.object.sha)}`, installationToken) as { tree: { sha: string } };
  const nameSlug = String(publication.revision.name).normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 45) || 'restaurant';
  const slug = `${publication.targetId ?? nameSlug}-${publication.jobId.slice(0, 8)}`;
  const newId = publication.targetId ?? slug;
  const snapshot = publication.type === 'new' ? newRecord(newId, publication.revision, publication.contentHash) : { ...publication.revision, id: newId, contentHash: publication.contentHash };
  const detailFile = `src/content/restaurants/${newId}.json`;
  const files: Record<string, string> = { [detailFile]: `${JSON.stringify(snapshot, null, 2)}\n` };
  if (publication.type !== 'new') {
    const existingFile = await github(`/repos/${owner}/${repo}/contents/${encodeURIComponent(detailFile)}?ref=dev`, installationToken) as { content?: string; encoding?: string };
    if (!existingFile.content || existingFile.encoding !== 'base64') throw new Error('target_restaurant_not_found');
    const current = JSON.parse(decodeGithubContent(existingFile.content));
    if (publication.type === 'review') current.reviews = [...(current.reviews ?? []), { text: String(publication.revision.body), author: '匿名同学' }];
    if (publication.type === 'correction') Object.assign(current, snapshot);
    if (current.id !== newId) throw new Error('target_id_mismatch');
    files[detailFile] = `${JSON.stringify(current, null, 2)}\n`;
  }
  const markdown = [`# ${String(publication.revision.name)}`, '', '## 位置', '', String(publication.revision.location), '', '## 消费范围', '', String(publication.revision.price ?? '待补充。'), '', '## 注意事项', '', String(publication.revision.openingHours ?? '营业情况可能变化，请以现场信息为准。'), '', '## 同学评价', '', `> ${String(publication.revision.body).replace(/\n/g, '\n> ')}`, '>', '> —— 匿名同学', ''].join('\n');
  const markdownBlob = await github(`/repos/${owner}/${repo}/git/blobs`, installationToken, false, { content: markdown, encoding: 'utf-8' }) as { sha: string };
  files[`src/content/markdown/${newId}.md`] = markdown;
  files[`.publication-manifest/${publication.jobId}.json`] = `${JSON.stringify({ jobId: publication.jobId, contentHash: publication.contentHash, submissionId: publication.submissionId ?? null })}\n`;
  const treeItems = await Promise.all(Object.entries(files).map(async ([path, content]) => {
    const blob = path.endsWith('.md') ? markdownBlob : await github(`/repos/${owner}/${repo}/git/blobs`, installationToken, false, { content, encoding: 'utf-8' }) as { sha: string };
    return { path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const tree = await github(`/repos/${owner}/${repo}/git/trees`, installationToken, false, { base_tree: baseCommit.tree.sha, tree: treeItems }) as { sha: string };
  const commit = await github(`/repos/${owner}/${repo}/git/commits`, installationToken, false, { message: `content: ${publication.type} ${newId}`, tree: tree.sha, parents: [base.object.sha] }) as { sha: string };
  await github(`/repos/${owner}/${repo}/git/refs`, installationToken, false, { ref: `refs/heads/${branch}`, sha: commit.sha });
  return github(`/repos/${owner}/${repo}/pulls`, installationToken, false, { title: `餐饮信息：${String(publication.revision.name)}`, body: `审核通过的投稿版本：${publication.contentHash}\n\n- 投稿类型：${publication.type}\n- 目标餐厅：${newId}\n- 审核原稿摘要：${String(publication.original.name ?? '')}\n- 确认评价与图片来源、许可后再合并。`, head: branch, base: 'dev' }, 'POST') as Promise<GitHubResponse<{ number: number; html_url: string }>>;
}

function newRecord(id: string, revision: Record<string, unknown>, contentHash: string) { return { id, name: revision.name, category: revision.category, kind: '餐厅', aliases: [], relatedRestaurantIds: [], location: revision.location, coordinates: null, price: '待核验。', openingHours: null, foods: [], reviews: [{ text: revision.body, author: '匿名同学' }], body: '由投稿审核员整理；补充实际价格与用餐日期后更新。', images: revision.imageUrl ? [{ url: revision.imageUrl, alt: String(revision.name), source: '投稿外链；授权状态需由审核员核对。', permission: 'external' }] : [], sources: [{ repository: 'anonymous-submission', path: contentHash, revision: contentHash, license: null }], visitedAt: revision.visitedAt ?? null, verifiedAt: null, updatedAt: new Date().toISOString().slice(0, 10) }; }

async function createInstallationToken(env: AppEnv['Bindings'], repo: string) {
  const jwt = await createAppJwt(env.GITHUB_APP_ID, env.GITHUB_PRIVATE_KEY);
  const installationId = Number(env.GITHUB_INSTALLATION_ID);
  if (!Number.isSafeInteger(installationId) || installationId <= 0) throw new Error('invalid_github_installation_id');
  const token = await github(`/app/installations/${installationId}/access_tokens`, jwt, false, { repositories: [repo], permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' } }, 'POST') as { token: string; expires_at: string };
  if (Date.parse(token.expires_at) < Date.now()) throw new Error('github_token_expired');
  return token.token;
}

async function exportV2Submission(env: AppEnv['Bindings'], publication: Publication): Promise<GitHubResponse<{ number: number; html_url: string }>> {
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
  const baseCommit = await github(`/repos/${owner}/${repo}/git/commits/${encodeURIComponent(base.object.sha)}`, installationToken) as { tree: { sha: string } };
  const parsed = publication.revision;
  const payload = isRecord(parsed.payload) ? parsed.payload : parsed;
  const entityType = publication.entityType;
  if (!entityType || !['venue', 'food', 'review'].includes(entityType)) throw new Error('invalid_v2_entity_type');
  const entityId = slugify(publication.entityId ?? publication.targetId ?? publication.jobId);
  const identity = publication.submissionId ? await env.DB.prepare('SELECT public_identity_recorded,submitter_user_id,public_author_alias,public_author_avatar FROM submissions WHERE id=?').bind(publication.submissionId).first<{ public_identity_recorded: number; submitter_user_id: number | null; public_author_alias: string | null; public_author_avatar: string | null }>() : null;
  const publicIdentity = identity && (identity.public_identity_recorded === 1 || identity.submitter_user_id != null)
    ? { authorAlias: identity.public_author_alias, authorAvatar: identity.public_author_alias ? publicAvatar(identity.public_author_avatar) : null } : {};
  const source = sourcesFromPayload(payload.sources, submissionSource(publication));
  const assets = await loadPublishedAssets(env, publication.submissionId);
  const entityAssets = assets.filter((asset) => asset.slot === 'entity');
  const reviewAssets = assets.filter((asset) => asset.slot === 'attachedReview');
  const files: ExportFile[] = [];
  const imageRecords = entityAssets.map((asset) => imageRecord(asset));
  if (entityType === 'venue') {
    const record = canonicalVenue(payload, entityId, imageRecords, source, publication.createdAt);
    venueSchema.parse(record);
    files.push(jsonFile(`src/content/restaurants/${entityId}.json`, record));
  } else if (entityType === 'food') {
    const parentId = slugify(publication.parentEntityId ?? publication.targetId ?? String(payload.venueId ?? ''));
    if (!parentId) throw new Error('missing_parent_venue');
    const parentPath = `src/content/restaurants/${parentId}.json`;
    const parent = await github(`/repos/${owner}/${repo}/contents/${encodeURIComponent(parentPath)}?ref=dev`, installationToken) as { content?: string; encoding?: string };
    if (!parent.content || parent.encoding !== 'base64') throw new Error('parent_venue_file_not_found');
    const parentRecord = JSON.parse(decodeGithubContent(parent.content)) as Record<string, unknown>;
    const foods = Array.isArray(parentRecord.foods) ? parentRecord.foods.map(String) : [];
    if (!foods.includes(entityId)) foods.push(entityId);
    parentRecord.foods = foods;
    venueSchema.parse(parentRecord);
    files.push(jsonFile(parentPath, parentRecord));
    const record = canonicalFood(payload, entityId, parentId, imageRecords, source, publication.createdAt);
    foodSchema.parse(record);
    files.push(jsonFile(`src/content/foods/${entityId}.json`, record));
  } else {
    const record = canonicalReview({ ...payload, ...publicIdentity }, entityId, imageRecords, source);
    reviewSchema.parse(record);
    files.push(jsonFile(`src/content/reviews/${entityId}.json`, record));
  }
  if (publication.submissionId) {
    const attached = await env.DB.prepare('SELECT id, target_type, target_id, rating, text FROM reviews WHERE submission_id = ? AND id = (SELECT attached_review_id FROM submissions WHERE id = ?) AND publication_state = \'pending\'').bind(publication.submissionId, publication.submissionId).first<{ id: string; target_type: string; target_id: string; rating: number; text: string }>();
    if (attached) {
      const record = canonicalReview({ ...(isRecord(payload.attachedReview) ? payload.attachedReview : {}), targetType: attached.target_type, targetId: attached.target_id, rating: attached.rating, text: attached.text, ...publicIdentity }, slugify(attached.id), reviewAssets.map((asset) => imageRecord(asset)), source);
      reviewSchema.parse(record);
      files.push(jsonFile(`src/content/reviews/${slugify(attached.id)}.json`, record));
    }
  }
  files.push(jsonFile(`.publication-manifest/${publication.jobId}.json`, { jobId: publication.jobId, contentHash: publication.contentHash, submissionId: publication.submissionId ?? null }));
  const treeItems = await Promise.all(files.map(async (file) => {
    const blob = await github(`/repos/${owner}/${repo}/git/blobs`, installationToken, false, { content: file.content, encoding: file.encoding }) as { sha: string };
    return { path: file.path, mode: '100644', type: 'blob', sha: blob.sha };
  }));
  const tree = await github(`/repos/${owner}/${repo}/git/trees`, installationToken, false, { base_tree: baseCommit.tree.sha, tree: treeItems }) as { sha: string };
  const commit = await github(`/repos/${owner}/${repo}/git/commits`, installationToken, false, { message: `content: ${entityType} ${entityId}`, tree: tree.sha, parents: [base.object.sha] }) as { sha: string };
  await github(`/repos/${owner}/${repo}/git/refs`, installationToken, false, { ref: `refs/heads/${branch}`, sha: commit.sha });
  return github(`/repos/${owner}/${repo}/pulls`, installationToken, false, { title: `餐饮信息：${String(payload.name ?? entityId)}`, body: `审核通过的投稿版本：${publication.contentHash}\n\n- 投稿类型：${entityType}\n- 实体：${entityId}\n- 内容哈希必须在生产部署回调中原样回传后才标记图片公开。`, head: branch, base: 'dev' }, 'POST') as Promise<GitHubResponse<{ number: number; html_url: string }>>;
}

type ExportFile = { path: string; content: string; encoding: 'utf-8' | 'base64' };
type MediaExport = { metadata_json?: string; id: string; slot: string; alt: string; source: string; source_note: string | null; copyright_holder: string; license: string; permission: string; is_illustrative: number; width: number; height: number };
function jsonFile(path: string, value: unknown): ExportFile { return { path, content: `${JSON.stringify(value, null, 2)}\n`, encoding: 'utf-8' }; }
function slugify(value: string): string { return String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'submission'; }
function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function submissionSource(publication: Publication) { return [{ repository: 'what-to-eat-in-shou-today-contributions', path: `submissions/${publication.submissionId ?? publication.jobId}`, revision: publication.contentHash, license: null, note: '由审核员依据投稿与来源声明整理。', sourceUrl: null, collectedAt: null }]; }
function sourcesFromPayload(value: unknown, fallback: unknown[]) { return Array.isArray(value) && value.length ? value.filter(isRecord).map((item) => ({ repository: String(item.repository), path: String(item.path), revision: String(item.revision), license: nullableString(item.license), note: nullableString(item.note), sourceUrl: nullableString(item.sourceUrl), collectedAt: nullableString(item.collectedAt) })) : fallback; }
export function canonicalVenue(value: Record<string, unknown>, id: string, images: unknown[], sources: unknown[], createdAt?: string) {
  const location = isRecord(value.location) ? value.location : value;
  const coordinates = Array.isArray(location.coordinates) && location.coordinates.length === 2 ? location.coordinates : null;
  const price = canonicalPrice(value.averagePrice);
  return { schemaVersion: 2, id, name: String(value.name ?? id).trim(), kind: String(value.kind ?? value.type ?? 'restaurant'), parentId: typeof value.parentId === 'string' ? slugify(value.parentId) : null, category: String(value.category ?? value.campusScope ?? 'off-campus'), aliases: strings(value.aliases), tags: strings(value.tags), location: { address: String(location.address ?? '').trim(), campusArea: nullableString(location.campusArea ?? location.campus), floor: nullableString(location.floor), landmark: nullableString(location.landmark), coordinates, distanceMeters: integerOrNull(location.distanceMeters ?? location.distanceM), distanceBasis: nullableString(location.distanceBasis) }, averagePrice: price, description: nullableString(value.description), openingHours: nullableString(value.openingHours), foods: strings(value.foods).map(slugify), images, sources, dates: { addedAt: createdAt?.slice(0, 10) ?? null, visitedAt: nullableString(value.visitedAt), verifiedAt: nullableString(value.verifiedAt), updatedAt: nullableString(value.updatedAt) } };
}
export function canonicalFood(value: Record<string, unknown>, id: string, venueId: string, images: unknown[], sources: unknown[], createdAt?: string) { return { schemaVersion: 2, id, name: String(value.name ?? id).trim(), venueId, mealTypes: strings(value.mealTypes ?? (value.mealType ? [value.mealType] : [])), price: canonicalFoodPrice(value.price), tags: strings(value.tags), description: nullableString(value.description), images, sources, dates: { addedAt: createdAt?.slice(0, 10) ?? null, visitedAt: nullableString(value.visitedAt), verifiedAt: nullableString(value.verifiedAt), updatedAt: nullableString(value.updatedAt) } }; }
export function canonicalReview(value: Record<string, unknown>, id: string, images: unknown[], sources: unknown[]) { return { schemaVersion: 2, id, targetType: String(value.targetType), targetId: slugify(String(value.targetId)), rating: Number.isInteger(value.rating) ? value.rating : null, text: String(value.text ?? ''), images, authorAlias: nullableString(value.authorAlias), ...(value.authorAvatar !== undefined ? { authorAvatar: nullableString(value.authorAlias) ? publicAvatar(value.authorAvatar) : null } : {}), visitedAt: nullableString(value.visitedAt), verifiedAt: nullableString(value.verifiedAt), updatedAt: nullableString(value.updatedAt), sources }; }
function canonicalPrice(value: unknown) { if (!isRecord(value)) return null; const amount = integerOrNull(value.amountCents); const min = integerOrNull(value.minCents); const max = integerOrNull(value.maxCents); return { minCents: amount ?? min ?? 0, maxCents: amount ?? max ?? min ?? 0, currency: 'CNY', unit: nullableString(value.unit) ?? '人', source: nullableString(value.source), verifiedAt: nullableString(value.verifiedAt) }; }
function canonicalFoodPrice(value: unknown) { if (!isRecord(value)) return null; const amount = integerOrNull(value.amountCents); const min = integerOrNull(value.minCents); const max = integerOrNull(value.maxCents); return { amountCents: amount, minCents: amount === null ? min : null, maxCents: amount === null ? max : null, currency: 'CNY', unit: nullableString(value.unit) ?? '份', source: nullableString(value.source), verifiedAt: nullableString(value.verifiedAt) }; }
function strings(value: unknown): string[] { return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean) : []; }
function nullableString(value: unknown): string | null { return typeof value === 'string' && value.trim() ? value.trim() : null; }
function integerOrNull(value: unknown): number | null { return Number.isInteger(value) ? Number(value) : null; }
export function imageRecord(asset: MediaExport) { const publicUrl = `https://eat.shoumc.com/media/${asset.id}.webp`; return { url: publicUrl, alt: asset.alt, sourceUrl: /^https:\/\//i.test(asset.source) ? asset.source : publicUrl, sourceNote: asset.source_note?.trim() || `${asset.source}；已转码WebP`, author: asset.copyright_holder, license: asset.license, permission: asset.permission === 'approved' ? 'approved' : 'pending', isIllustrative: Boolean(asset.is_illustrative), coverEligible: asset.metadata_json ? JSON.parse(asset.metadata_json).coverAllowed === true : false, width: asset.width ?? null, height: asset.height ?? null }; }
async function loadPublishedAssets(env: AppEnv['Bindings'], submissionId?: string): Promise<MediaExport[]> {
  if (!submissionId) return [];
  const rows = await env.DB.prepare("SELECT id, slot, metadata_json, object_key, alt, source, source_note, copyright_holder, license, permission, is_illustrative, width, height FROM media_assets WHERE submission_id = ? AND object_state = 'private' AND permission = 'approved' ORDER BY slot, slot_index").bind(submissionId).all<MediaExport & { object_key: string }>();
  if (!rows.results.length) return [];
  return rows.results;
}

export function decodeGithubContent(content: string): string {
  const binary = atob(content.replace(/\s/g, ''));
  return new TextDecoder().decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** Create a short-lived GitHub App JWT. GitHub exports its private key in
 * either PKCS#1 (RSA PRIVATE KEY) or PKCS#8 (PRIVATE KEY) PEM form. WebCrypto
 * only accepts PKCS#8 for RSA imports, so PKCS#1 is wrapped without logging
 * or persisting key material. */
export async function createAppJwt(appId: string, privateKey: string) {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: unknown) => btoa(JSON.stringify(value)).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  const head = encode({ alg: 'RS256', typ: 'JWT' }); const payload = encode({ iat: now - 30, exp: now + 540, iss: appId }); const input = `${head}.${payload}`;
  const normalized = privateKey.replace(/\\n/g, '\n').trim();
  const pkcs1 = /-----BEGIN RSA PRIVATE KEY-----/.test(normalized);
  const encoded = normalized.replace(/-----BEGIN (?:RSA )?PRIVATE KEY-----|-----END (?:RSA )?PRIVATE KEY-----|\s/g, '');
  const der = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
  const importBytes = pkcs1 ? wrapPkcs1AsPkcs8(der) : der;
  const key = await crypto.subtle.importKey('pkcs8', toArrayBuffer(importBytes), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const signed = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(input));
  const signature = btoa(String.fromCharCode(...new Uint8Array(signed))).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${input}.${signature}`;
}

function wrapPkcs1AsPkcs8(pkcs1: Uint8Array): Uint8Array {
  const version = der(0x02, Uint8Array.of(0));
  const algorithm = der(0x30, concat(der(0x06, Uint8Array.of(0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01)), der(0x05, new Uint8Array())));
  return der(0x30, concat(version, algorithm, der(0x04, pkcs1)));
}

function der(tag: number, value: Uint8Array): Uint8Array { return concat(Uint8Array.of(tag), derLength(value.length), value); }
function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  const bytes: number[] = []; let value = length;
  while (value > 0) { bytes.unshift(value & 0xff); value >>>= 8; }
  return Uint8Array.of(0x80 | bytes.length, ...bytes);
}
function concat(...parts: Uint8Array[]): Uint8Array { const result = new Uint8Array(parts.reduce((total, part) => total + part.length, 0)); let offset = 0; for (const part of parts) { result.set(part, offset); offset += part.length; } return result; }
function toArrayBuffer(value: Uint8Array): ArrayBuffer { const copy = new Uint8Array(value.length); copy.set(value); return copy.buffer; }

async function github(path: string, token: string, allowMissing = false, body?: unknown, method = body ? 'POST' : 'GET'): Promise<any> {
  const response = await fetch(`https://api.github.com${path}`, { method, headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'User-Agent': 'shou-food-publisher', 'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  if (allowMissing && response.status === 404) return null;
  if (!response.ok) throw new Error(`github_${response.status}`);
  return response.json().catch(() => ({}));
}

async function exportManagedEdit(env: AppEnv['Bindings'], publication: Publication): Promise<{number:number;html_url:string}> {
  const [owner,repo]=env.GITHUB_REPOSITORY.split('/');
  if(!owner||!repo||env.GITHUB_REPOSITORY.split('/').length!==2)throw new Error('invalid_github_repository');
  const token=await createInstallationToken(env,repo);
  const root=`/repos/${owner}/${repo}`;
  const existing=await github(`${root}/git/ref/heads/${encodeURIComponent(publication.branch)}`,token,true);
  if(existing){
    const filter=`${root}/pulls?head=${encodeURIComponent(owner+':'+publication.branch)}`;
    const pulls=await github(filter+'&state=open',token);if(pulls.length)return pulls[0];
    const closed=await github(filter+'&state=closed',token);
    const retryable=closed.find((pr:{merged_at:string|null;base:{ref:string}})=>!pr.merged_at&&pr.base.ref==='dev');
    if(retryable)return github(`${root}/pulls/${retryable.number}`,token,false,{state:'open'},'PATCH');
    throw new Error('publication_branch_exists_without_open_pr');
  }
  const change=publication.revision;
  const type=change.entityType as ManagedType;
  if(change.operation!=='catalog-edit'||!['venue','food','review'].includes(type))throw new Error('invalid_catalog_edit');
  const desired=parseManaged(type,change.record);
  const base=await github(`${root}/git/ref/heads/dev`,token);
  const commit=await github(`${root}/git/commits/${base.object.sha}`,token);
  const folder=(kind:ManagedType)=>kind==='venue'?'restaurants':kind==='food'?'foods':'reviews';
  const path=(kind:ManagedType,id:string)=>`src/content/${folder(kind)}/${id}.json`;
  const cache=new Map<string,ManagedRecord>();
  async function read(kind:ManagedType,id:string){
    const key=kind+':'+id;if(cache.has(key))return cache.get(key)!;
    const file=await github(`${root}/contents/${encodeURIComponent(path(kind,id))}?ref=${base.object.sha}`,token);
    const record=parseManaged(kind,JSON.parse(decodeGithubContent(file.content)));cache.set(key,record);return record;
  }
  const before=await read(type,desired.id);
  const mirror={...before,...(type==='venue'?{tags:deriveDistanceTags(before as import('../../lib/catalog/index.js').Venue)}:{}),images:before.images.filter(image=>image.permission==='approved')};
  const hashBytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(mirror)));
  const hash=Array.from(new Uint8Array(hashBytes),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(hash!==change.expectedHash)throw new Error('catalog_revision_conflict');
  // Edit against the same normalized version shown in the admin, preserving
  // pending source images that are deliberately absent from the mirror.
  const next=validateManagedEdit(type,mirror,desired);
  const treeFiles=await github(`${root}/git/trees/${commit.tree.sha}?recursive=1`,token);
  if(treeFiles.truncated)throw new Error('catalog_tree_truncated');
  const venueFiles=treeFiles.tree.filter((item:{path:string})=>/^src\/content\/restaurants\/[a-z0-9-]+\.json$/.test(item.path));
  // Parent cycles / active child venues must use the same Git base, not a stale D1 mirror.
  for(const file of venueFiles)await read('venue',file.path.split('/').at(-1).slice(0,-5));
  if(type==='venue')for(const id of (before as import('../../lib/catalog/index.js').Venue).foods)await read('food',id);
  if(type!=='review'){
    const cover=(next as import('../../lib/catalog/index.js').Food).cover;
    if(cover?.reviewId)await read('review',cover.reviewId);
  }
  validateManagedRelations(type,next,[...cache.entries()].map(([key,record])=>({type:key.split(':')[0] as ManagedType,record})));
  const files=new Map<string,ManagedRecord>();
  // Preserve unpublished image provenance, even though the admin cannot select it.
  next.images=[...next.images,...before.images.filter(image=>image.permission!=='approved')];
  if('dates' in next)next.dates.updatedAt=new Date().toISOString().slice(0,10);
  if(type==='food'&&(before as import('../../lib/catalog/index.js').Food).venueId!==(next as import('../../lib/catalog/index.js').Food).venueId){
    const oldParent=await read('venue',(before as import('../../lib/catalog/index.js').Food).venueId) as import('../../lib/catalog/index.js').Venue;
    const newParent=await read('venue',(next as import('../../lib/catalog/index.js').Food).venueId) as import('../../lib/catalog/index.js').Venue;
    oldParent.foods=oldParent.foods.filter(id=>id!==next.id);newParent.foods=[...new Set([...newParent.foods,next.id])];
    files.set(path('venue',oldParent.id),oldParent);files.set(path('venue',newParent.id),newParent);
  }
  files.set(path(type,next.id),next);
  const output:ExportFile[]=[...files].map(([path,record])=>jsonFile(path,record));
  output.push(jsonFile(`.publication-manifest/${publication.jobId}.json`,{jobId:publication.jobId,contentHash:publication.contentHash,submissionId:publication.submissionId}));
  const items=await Promise.all(output.map(async file=>({path:file.path,mode:'100644',type:'blob',sha:(await github(`${root}/git/blobs`,token,false,{content:file.content,encoding:'utf-8'})).sha})));
  const tree=await github(`${root}/git/trees`,token,false,{base_tree:commit.tree.sha,tree:items});
  const created=await github(`${root}/git/commits`,token,false,{message:`content: update ${type} ${next.id}`,tree:tree.sha,parents:[base.object.sha]});
  await github(`${root}/git/refs`,token,false,{ref:`refs/heads/${publication.branch}`,sha:created.sha});
  return github(`${root}/pulls`,token,false,{title:`内容维护：${'name' in next?next.name:next.id}`,body:`更新已有内容，保留来源、评价和修改历史。\n\n内容版本：${publication.contentHash}\n\n检查字段变化、关联及封面来源；生产部署成功后才标记已发布。`,head:publication.branch,base:'dev'},'POST');
}

export async function hasOpenPublication(env:AppEnv['Bindings'],branch:string):Promise<boolean>{
 const [owner,repo]=env.GITHUB_REPOSITORY.split('/');
 if(!owner||!repo||env.GITHUB_REPOSITORY.split('/').length!==2)throw new Error('invalid_github_repository');
 const token=await createInstallationToken(env,repo);
 const pulls=await github(`/repos/${owner}/${repo}/pulls?head=${encodeURIComponent(owner+':'+branch)}&state=open`,token);
 return Array.isArray(pulls)&&pulls.length>0;
}
