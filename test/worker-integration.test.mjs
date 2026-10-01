import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { webcrypto } from 'node:crypto';
import worker from '../src/worker/index.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const snapshotSeed = loadSeedSql();
const ACCESS_DOMAIN = 'team.example.cloudflareaccess.com';
const ACCESS_AUDIENCE = 'access-audience';
const ACCESS_EMAIL = 'reviewer@example.com';
const DEPLOY_SECRET = 'deploy-secret';
const REPOSITORY = 'owner/repository';
const TURNSTILE_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';
const ACCESS_CERTS_URL = `https://${ACCESS_DOMAIN}/cdn-cgi/access/certs`;

function loadSeedSql() {
  const path = join(root, '.generated', 'seed.sql');
  if (!existsSync(path)) {
    const command = process.platform === 'win32' ? join(root, 'node_modules', '.bin', 'tsx.cmd') : join(root, 'node_modules', '.bin', 'tsx');
    execFileSync(command, ['scripts/prepare-catalog.mjs'], { cwd: root, stdio: 'pipe' });
  }
  return readFileSync(path, 'utf8');
}

class D1Statement {
  constructor(database, sql, values = []) { this.database = database; this.sql = sql; this.values = values; }
  bind(...values) { return new D1Statement(this.database, this.sql, values); }
  runSync() {
    const result = this.database.prepare(this.sql).run(...this.values);
    return { meta: { changes: Number(result.changes) } };
  }
  async run() { return this.runSync(); }
  async first() { return this.database.prepare(this.sql).get(...this.values) ?? null; }
  async all() { return { results: this.database.prepare(this.sql).all(...this.values) }; }
}

class SqliteD1 {
  constructor(seed = true) {
    this.sqlite = new DatabaseSync(':memory:');
    this.sqlite.exec('PRAGMA foreign_keys = ON;');
    for (const name of readdirSync(join(root, 'migrations')).filter((name) => /^\d+.*\.sql$/.test(name)).sort()) {
      this.sqlite.exec(readFileSync(join(root, 'migrations', name), 'utf8'));
    }
    if (seed) this.sqlite.exec(snapshotSeed);
  }
  prepare(sql) { return new D1Statement(this.sqlite, sql); }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try {
      const results = statements.map((statement) => statement.runSync());
      this.sqlite.exec('COMMIT');
      return results;
    } catch (error) {
      this.sqlite.exec('ROLLBACK');
      throw error;
    }
  }
}

function runtime(database, overrides = {}) {
  return {
    DB: database,
    ASSETS: { fetch: async () => new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } }) },
    MEDIA_MODE: 'external',
    ALLOWED_ORIGINS: 'https://eat.shoumc.com',
    PUBLICATION_ENABLED: 'true',
    LEGACY_SUBMISSIONS_ENABLED: 'false',
    TURNSTILE_SECRET_KEY: 'turnstile-test-secret',
    TURNSTILE_HOSTNAME: 'eat.shoumc.com',
    ACCESS_TEAM_DOMAIN: ACCESS_DOMAIN,
    ACCESS_AUD: ACCESS_AUDIENCE,
    ACCESS_REVIEWER_EMAIL: ACCESS_EMAIL,
    GITHUB_APP_ID: '123',
    GITHUB_PRIVATE_KEY: 'private-key',
    GITHUB_INSTALLATION_ID: '123',
    GITHUB_REPOSITORY: REPOSITORY,
    GITHUB_WEBHOOK_SECRET: 'github-secret',
    DEPLOY_WEBHOOK_SECRET: DEPLOY_SECRET,
    ...overrides,
  };
}

function request(path, init = {}) { return new Request(`https://eat.shoumc.com${path}`, init); }

async function withExternalStubs(callback, { access = false } = {}) {
  const originalFetch = globalThis.fetch;
  const accessKeys = access ? await accessKeyPair() : null;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === TURNSTILE_URL) return jsonResponse({ success: true, action: 'submission', hostname: 'eat.shoumc.com' });
    if (url === ACCESS_CERTS_URL) return jsonResponse({ keys: [accessKeys.publicJwk] });
    throw new Error(`unexpected external request: ${url}`);
  };
  try { return await callback(accessKeys); } finally { globalThis.fetch = originalFetch; }
}

function jsonResponse(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } }); }
function plain(value) { return value === null || value === undefined ? value : Object.fromEntries(Object.entries(value)); }

function source() { return { repository: 'integration', path: 'fixture.json', revision: 'test', license: null }; }

function uploadWebp() {
  const payload = Uint8Array.from([0, 0, 0, 0, 1, 0, 0, 1, 0, 0]);
  const output = new Uint8Array(12 + 8 + payload.length + (payload.length % 2));
  output.set(new TextEncoder().encode('RIFF'), 0);
  new DataView(output.buffer).setUint32(4, output.length - 8, true);
  output.set(new TextEncoder().encode('WEBP'), 8);
  output.set(new TextEncoder().encode('VP8X'), 12);
  new DataView(output.buffer).setUint32(16, payload.length, true);
  output.set(payload, 20);
  return output;
}

function fakeR2Bucket() {
  const objects = new Map();
  return {
    objects,
    async put(key, body, options = {}) {
      const bytes = new Uint8Array(await new Response(body).arrayBuffer());
      objects.set(key, { bytes, customMetadata: { ...(options.customMetadata ?? {}) }, httpMetadata: { ...(options.httpMetadata ?? {}) } });
    },
    async get(key) {
      const object = objects.get(key);
      if (!object) return null;
      const bytes = object.bytes.slice();
      return { body: new Response(bytes).body, customMetadata: { ...object.customMetadata }, httpEtag: '"integration-etag"', async arrayBuffer() { return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength); } };
    },
    async delete(key) { objects.delete(key); },
  };
}

function imageUploadHeaders(receiptToken, slotIndex, version) {
  const encode = encodeURIComponent;
  return {
    'Content-Type': 'image/webp',
    Authorization: `Bearer ${receiptToken}`,
    'X-Image-Slot': 'entity',
    'X-Image-Index': String(slotIndex),
    'X-Submission-Version': String(version),
    'X-Image-Metadata-Encoding': 'percent-utf8',
    'X-Image-Alt': encode('酸菜鱼照片'),
    'X-Image-Source': encode('本人拍摄'),
    'X-Image-Source-Note': encode('本人拍摄；本人授权；本站 WebP 转码'),
    'X-Image-Copyright-Holder': encode('投稿同学'),
    'X-Image-License': encode('本人授权发布'),
    'X-Image-Permission': 'pending',
    'X-Image-Rights-Confirmed': 'true',
    'X-Image-Is-Illustrative': 'false',
  };
}

function venuePayload(name = '集成测试 venue') {
  return {
    name, type: 'stall', campusScope: 'on-campus',
    location: { address: '集成测试地址', coordinates: [31.23, 121.49] },
    averagePrice: null, tags: [], sources: [source()],
  };
}

function foodPayload() {
  return {
    name: '集成测试食物', mealTypes: ['meal'],
    price: { amountCents: 1900, currency: 'CNY', unit: '份', source: '集成测试声明', verifiedAt: null },
    tags: [], description: null, sources: [source()],
  };
}

function snapshotId(database) {
  return database.sqlite.prepare("SELECT id FROM catalog_snapshots WHERE status = 'published' ORDER BY generated_at DESC LIMIT 1").get().id;
}

async function submitV2(runtimeValue, database, entityType, payload, extra = {}) {
  const response = await worker.fetch(request('/api/v2/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': extra.ip ?? '198.51.100.10', ...(extra.headers ?? {}) },
    body: JSON.stringify({ schemaVersion: 2, entityType, snapshotId: snapshotId(database), payload, expectedImages: 0, expectedReviewImages: 0, turnstileToken: 'turnstile-token', ...extra.body }),
  }), runtimeValue, {});
  const body = await response.json();
  return { response, body };
}

async function accessKeyPair() {
  if (!accessKeyPair.cached) {
    const keyPair = await webcrypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
    const publicJwk = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
    publicJwk.kid = 'integration-key';
    accessKeyPair.cached = { privateKey: keyPair.privateKey, publicJwk };
  }
  return accessKeyPair.cached;
}

async function accessToken(keys, claims = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'RS256', typ: 'JWT', kid: 'integration-key' });
  const payload = encode({ iss: `https://${ACCESS_DOMAIN}`, aud: ACCESS_AUDIENCE, exp: Math.floor(Date.now() / 1000) + 300, email: ACCESS_EMAIL, ...claims });
  const input = `${header}.${payload}`;
  const signature = await webcrypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, new TextEncoder().encode(input));
  return `${input}.${Buffer.from(signature).toString('base64url')}`;
}

function deploySignature(body) { return `sha256=${createHmac('sha256', DEPLOY_SECRET).update(body).digest('hex')}`; }

function sha256Hex(value) { return createHash('sha256').update(value).digest('hex'); }

async function deploymentCallback(runtimeValue, payload) {
  const body = JSON.stringify(payload);
  return worker.fetch(request('/api/v1/webhooks/deploy', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Deploy-Signature': deploySignature(body) },
    body,
  }), runtimeValue, {});
}

async function runAdminRace(actions) {
  const database = new SqliteD1();
  const values = { submissionId: 'admin-race', entityId: 'admin-race-venue', snapshotId: snapshotId(database), expectedImages: 1 };
  insertBareV2Venue(database, values);
  database.sqlite.prepare("UPDATE submissions SET expected_images = 1 WHERE id = 'admin-race'").run();
  insertMedia(database, { ...values, assetId: 'admin-race-media' });
  const runtimeValue = runtime(database);
  const responses = await withExternalStubs(async (keys) => {
    const token = await accessToken(keys);
    const headers = { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token };
    return Promise.all(actions.map((action) => worker.fetch(request('/api/v2/admin/submissions/admin-race/review', {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, expectedVersion: 1, ...(action === 'reject' ? { reason: '并发测试拒绝' } : {}) }),
    }), runtimeValue, {})));
  }, { access: true });
  return { database, responses };
}

function insertBareV2Venue(database, values) {
  const now = '2026-10-01T00:00:00.000Z';
  const revision = JSON.stringify({ schemaVersion: 2, entityType: 'venue', snapshotId: values.snapshotId, payload: venuePayload(values.name ?? values.entityId) });
  database.sqlite.prepare('INSERT INTO submissions (id, type, target_restaurant_id, original_json, revision_json, receipt_hash, status, version, created_at, updated_at, schema_version, entity_type, entity_id, upload_state, expected_images, expected_review_images, snapshot_id, parent_entity_id, parent_receipt_hash, private_json, attached_review_id) VALUES (?, \'new\', NULL, ?, ?, ?, ?, ?, ?, ?, 2, \'venue\', ?, ?, ?, 0, ?, NULL, NULL, \'{}\', NULL)').run(values.submissionId, revision, revision, `receipt-${values.submissionId}`, values.status ?? 'pending', values.version ?? 1, now, now, values.entityId, values.uploadState ?? 'pending', values.expectedImages ?? 0, values.snapshotId);
  database.sqlite.prepare('INSERT INTO venues (id, submission_id, type, campus_scope, name, address, schema_version, publication_state, snapshot_id, content_hash, created_at, updated_at) VALUES (?, ?, \'stall\', \'on-campus\', ?, \'集成测试地址\', 2, ?, ?, ?, ?, ?)').run(values.entityId, values.submissionId, values.name ?? values.entityId, values.publicationState ?? 'pending', values.snapshotId, 'a'.repeat(64), now, now);
}

function insertMedia(database, values) {
  const now = '2026-10-01T00:00:00.000Z';
  database.sqlite.prepare('INSERT INTO media_assets (id, submission_id, entity_type, entity_id, slot, slot_index, object_key, content_type, byte_size, width, height, alt, source, copyright_holder, license, permission, rights_confirmed, is_illustrative, object_state, schema_version, created_at, content_hash, metadata_json) VALUES (?, ?, \'venue\', ?, \'entity\', 0, ?, \'image/webp\', 1, 1, 1, \'集成测试图片\', \'本人拍摄\', \'投稿同学\', \'本人授权发布\', \'pending\', 1, 0, \'private\', 2, ?, ?, ?)').run(values.assetId, values.submissionId, values.entityId, `media/${values.assetId}.webp`, now, 'b'.repeat(64), '{}');
}

function upsertVenueMirror(database, entityId, snapshot, contentHash, syncedAt) {
  const parent = database.sqlite.prepare('SELECT id, name, type, campus_scope, address FROM venues WHERE id = ?').get(entityId);
  const payload = JSON.stringify({
    schemaVersion: 2,
    id: parent.id,
    name: parent.name,
    kind: parent.type,
    parentId: null,
    category: parent.campus_scope,
    aliases: [],
    tags: [],
    location: { address: parent.address, campusArea: null, floor: null, landmark: null, coordinates: null, distanceMeters: null, distanceBasis: null },
    averagePrice: null,
    description: null,
    openingHours: null,
    foods: [],
    images: [],
    sources: [source()],
    dates: { visitedAt: null, verifiedAt: null, updatedAt: null },
  });
  database.sqlite.prepare('INSERT INTO catalog_mirror (entity_type, entity_id, snapshot_id, payload_json, content_hash, synced_at) VALUES (\'venue\', ?, ?, ?, ?, ?) ON CONFLICT(entity_type, entity_id) DO UPDATE SET snapshot_id = excluded.snapshot_id, payload_json = excluded.payload_json, content_hash = excluded.content_hash, synced_at = excluded.synced_at').run(entityId, snapshot, payload, contentHash, syncedAt);
}

function stageMergedMainJob(database, submissionId, jobId, commit) {
  const revisionJson = database.sqlite.prepare('SELECT revision_json FROM submissions WHERE id = ?').get(submissionId).revision_json;
  const contentHash = sha256Hex(revisionJson);
  const now = '2026-10-01T00:00:00.000Z';
  database.sqlite.prepare("UPDATE submissions SET status = 'merged_main' WHERE id = ? AND status = 'pending'").run(submissionId);
  database.sqlite.prepare("INSERT INTO publication_jobs (id, submission_id, submission_version, content_hash, status, branch, attempts, main_commit_sha, created_at, updated_at) VALUES (?, ?, 1, ?, 'merged_main', ?, 0, ?, ?, ?)").run(jobId, submissionId, contentHash, `submission/${submissionId.toLowerCase()}`, commit, now, now);
  return { contentHash };
}

function publishStaticSnapshotB(database, snapshotA, parentEntityId) {
  const snapshotB = `catalog-v2-${'b'.repeat(16)}`;
  const snapshotHash = 'c'.repeat(64);
  const now = '2026-10-02T00:00:00.000Z';
  database.sqlite.prepare("UPDATE catalog_snapshots SET status = 'superseded' WHERE id = ?").run(snapshotA);
  database.sqlite.prepare("INSERT INTO catalog_snapshots (id, content_hash, source_revision, generated_at, status) VALUES (?, ?, 'integration-mirror-B', ?, 'published')").run(snapshotB, snapshotHash, now);
  upsertVenueMirror(database, parentEntityId, snapshotB, snapshotHash, now);
  return snapshotB;
}

test('real migrations and generated seed preserve a pending normalized row', () => {
  const database = new SqliteD1();
  const now = '2026-10-01T00:00:00.000Z';
  database.sqlite.prepare('INSERT INTO submissions (id, type, original_json, revision_json, receipt_hash, status, version, created_at, updated_at, schema_version, entity_type, entity_id, upload_state, expected_images, expected_review_images, snapshot_id, private_json) VALUES (?, \'new\', \'{}\', \'{}\', ?, \'pending\', 1, ?, ?, 2, \'venue\', ?, \'pending\', 0, 0, ?, \'{}\')').run('seed-pending', 'seed-receipt', now, now, 'seed-pending-entity', snapshotId(database));
  database.sqlite.prepare("UPDATE venues SET submission_id = 'seed-pending', publication_state = 'pending', name = '待审核覆盖' WHERE id = 'first-canteen'").run();
  database.sqlite.exec(snapshotSeed);
  const row = plain(database.sqlite.prepare('SELECT submission_id, publication_state, name FROM venues WHERE id = ?').get('first-canteen'));
  assert.deepEqual(row, { submission_id: 'seed-pending', publication_state: 'pending', name: '待审核覆盖' });
  assert.ok(database.sqlite.prepare('SELECT COUNT(*) AS count FROM catalog_mirror').get().count > 0);
});

test('v2 venue and food submissions preserve receipt binding for an own pending parent', async () => {
  const database = new SqliteD1();
  const runtimeValue = runtime(database);
  await withExternalStubs(async () => {
    const venue = await submitV2(runtimeValue, database, 'venue', venuePayload());
    assert.equal(venue.response.status, 202);
    assert.ok(venue.body.receiptToken);
    const food = await submitV2(runtimeValue, database, 'food', foodPayload(), {
      body: { parent: { venueEntityId: venue.body.entityId, parentReceiptToken: venue.body.receiptToken } },
      ip: '198.51.100.11',
    });
    assert.equal(food.response.status, 202);
    const foodRow = plain(database.sqlite.prepare('SELECT venue_id, publication_state FROM foods WHERE submission_id = ?').get(food.body.submissionId));
    assert.deepEqual(foodRow, { venue_id: venue.body.entityId, publication_state: 'pending' });
    const status = await worker.fetch(request(`/api/v2/submissions/${food.body.submissionId}/status`, { headers: { Authorization: `Bearer ${food.body.receiptToken}` } }), runtimeValue, {});
    assert.equal(status.status, 200);
    const statusBody = await status.json();
    assert.doesNotMatch(JSON.stringify(statusBody), /receiptToken|receipt_hash|revision_json|original_json/);
    const wrong = await worker.fetch(request(`/api/v2/submissions/${food.body.submissionId}/status`, { headers: { Authorization: 'Bearer wrong-receipt-token' } }), runtimeValue, {});
    assert.equal(wrong.status, 404);
  });
});

test('a new venue hierarchy only accepts an existing published parent', async () => {
  const database = new SqliteD1();
  const runtimeValue = runtime(database);
  await withExternalStubs(async () => {
    const missing = await submitV2(runtimeValue, database, 'venue', { ...venuePayload(), parentId: 'missing-parent' });
    assert.equal(missing.response.status, 422);
    assert.equal(missing.body.error.code, 'parent_venue_unavailable');
    assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM submissions').get().count, 0);
    const parent = await submitV2(runtimeValue, database, 'venue', venuePayload('审核中的父店铺'));
    const pending = await submitV2(runtimeValue, database, 'venue', { ...venuePayload(), parentId: parent.body.entityId });
    assert.equal(pending.response.status, 422);
    assert.equal(pending.body.error.code, 'parent_venue_unavailable');
    const accepted = await submitV2(runtimeValue, database, 'venue', { ...venuePayload(), parentId: 'first-canteen' });
    assert.equal(accepted.response.status, 202);
    const saved = JSON.parse(database.sqlite.prepare('SELECT revision_json FROM submissions WHERE id = ?').get(accepted.body.submissionId).revision_json);
    assert.equal(saved.payload.parentId, 'first-canteen');
  });
});

test('finalize rejects a v2 submission whose declared image is missing', async () => {
  const database = new SqliteD1();
  const runtimeValue = runtime(database);
  await withExternalStubs(async () => {
    const created = await submitV2(runtimeValue, database, 'venue', venuePayload('待图片 venue'), { body: { expectedImages: 1 } });
    assert.equal(created.response.status, 202);
    const response = await worker.fetch(request(`/api/v2/submissions/${created.body.submissionId}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.body.receiptToken}` },
      body: JSON.stringify({ expectedVersion: 1, expectedImages: 1, expectedReviewImages: 0 }),
    }), runtimeValue, {});
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'image_count_mismatch');
  });
});

test('real SQLite and R2 upload path persists private images and finalizes by version and count', async () => {
  const database = new SqliteD1();
  const bucket = fakeR2Bucket();
  const runtimeValue = runtime(database, { MEDIA_MODE: 'r2', IMAGES: bucket });
  const bytes = uploadWebp();
  await withExternalStubs(async () => {
    const created = await submitV2(runtimeValue, database, 'venue', venuePayload('待上传图片 venue'), { body: { expectedImages: 2 } });
    assert.equal(created.response.status, 202, JSON.stringify(created.body));
    assert.equal(created.body.status, 'uploading');
    assert.equal(created.body.version, 1);

    const finalizeEarly = await worker.fetch(request(`/api/v2/submissions/${created.body.submissionId}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.body.receiptToken}` },
      body: JSON.stringify({ expectedVersion: 1, expectedImages: 2, expectedReviewImages: 0 }),
    }), runtimeValue, {});
    assert.equal(finalizeEarly.status, 409);
    assert.equal((await finalizeEarly.json()).error.code, 'image_count_mismatch');

    const upload = (slotIndex, version) => worker.fetch(request(`/api/v2/submissions/${created.body.submissionId}/images`, {
      method: 'POST',
      headers: imageUploadHeaders(created.body.receiptToken, slotIndex, version),
      body: bytes,
    }), runtimeValue, {});
    const first = await upload(0, 1);
    assert.equal(first.status, 201, await first.clone().text());
    const firstBody = await first.json();
    assert.equal(firstBody.version, 2);

    const stale = await upload(1, 1);
    assert.equal(stale.status, 409);
    assert.equal((await stale.json()).error.code, 'version_conflict');

    const second = await upload(1, 2);
    assert.equal(second.status, 201, await second.clone().text());
    const secondBody = await second.json();
    assert.equal(secondBody.version, 3);

    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM media_assets WHERE submission_id = ? AND object_state = 'private'").get(created.body.submissionId).count, 2);
    assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM media_reservations WHERE submission_id = ? AND state = 'committed'").get(created.body.submissionId).count, 2);
    assert.deepEqual(plain(database.sqlite.prepare('SELECT version, upload_state FROM submissions WHERE id = ?').get(created.body.submissionId)), { version: 3, upload_state: 'uploading' });
    for (const assetId of [firstBody.assetId, secondBody.assetId]) {
      const object = bucket.objects.get(`media/${assetId}.webp`);
      assert.ok(object);
      assert.equal(object.customMetadata.visibility, 'private');
      assert.equal(object.customMetadata.entityType, 'venue');
    }

    const finalized = await worker.fetch(request(`/api/v2/submissions/${created.body.submissionId}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.body.receiptToken}` },
      body: JSON.stringify({ expectedVersion: 3, expectedImages: 2, expectedReviewImages: 0 }),
    }), runtimeValue, {});
    assert.equal(finalized.status, 200, await finalized.clone().text());
    assert.deepEqual(await finalized.json(), { submissionId: created.body.submissionId, status: 'pending', version: 4, uploadedImages: 2, uploadedReviewImages: 0 });
    assert.deepEqual(plain(database.sqlite.prepare('SELECT version, upload_state FROM submissions WHERE id = ?').get(created.body.submissionId)), { version: 4, upload_state: 'pending' });

    const staleFinalize = await worker.fetch(request(`/api/v2/submissions/${created.body.submissionId}/finalize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${created.body.receiptToken}` },
      body: JSON.stringify({ expectedVersion: 3, expectedImages: 2, expectedReviewImages: 0 }),
    }), runtimeValue, {});
    assert.equal(staleFinalize.status, 409);
    assert.equal((await staleFinalize.json()).error.code, 'version_conflict');
  });
});

test('an attached review and its photos remain private and finalize together with venue photos', async () => {
  const database = new SqliteD1();
  const bucket = fakeR2Bucket();
  const env = runtime(database, { MEDIA_MODE: 'r2', IMAGES: bucket });
  await withExternalStubs(async () => {
    const created = await submitV2(env, database, 'venue', { ...venuePayload('随稿评价测试'), attachedReview: { rating: 4, text: '测试用评价 😀' } }, { body: { expectedImages: 1, expectedReviewImages: 1 } });
    assert.equal(created.response.status, 202, JSON.stringify(created.body));
    const receipt=created.body;
    const review=database.sqlite.prepare('SELECT target_type,target_id,rating,text,publication_state FROM reviews WHERE submission_id = ?').get(receipt.submissionId);
    assert.equal(review.rating,4);assert.equal(review.text,'测试用评价 😀');assert.equal(review.target_id,receipt.entityId);assert.equal(review.publication_state,'pending');
    const upload=async(slot,version)=>worker.fetch(request(`/api/v2/submissions/${receipt.submissionId}/images`,{method:'POST',headers:{...imageUploadHeaders(receipt.receiptToken,0,version),'X-Image-Slot':slot},body:uploadWebp()}),env,{});
    assert.equal((await upload('entity',1)).status,201);
    const finalize=version=>worker.fetch(request(`/api/v2/submissions/${receipt.submissionId}/finalize`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${receipt.receiptToken}`},body:JSON.stringify({expectedVersion:version,expectedImages:1,expectedReviewImages:1})}),env,{});
    assert.equal((await finalize(2)).status,409);
    assert.equal((await upload('attachedReview',2)).status,201);
    assert.equal((await finalize(3)).status,200);
    const assets=database.sqlite.prepare('SELECT slot,object_state,permission FROM media_assets WHERE submission_id = ? ORDER BY slot').all(receipt.submissionId).map(plain);
    assert.deepEqual(assets,[{slot:'attachedReview',object_state:'private',permission:'pending'},{slot:'entity',object_state:'private',permission:'pending'}]);
    const status=await worker.fetch(request(`/api/v2/submissions/${receipt.submissionId}/status`,{headers:{Authorization:`Bearer ${receipt.receiptToken}`}}),env,{});
    const body=await status.json();assert.equal(body.status,'pending');assert.equal(body.uploadedImages,1);assert.equal(body.uploadedReviewImages,1);assert.doesNotMatch(JSON.stringify(body),/测试用评价|receiptToken|revision_json/);
  });
});

test('same-version admin approve/reject leaves only the winning CAS side effects', async () => {
  const { database, responses } = await runAdminRace(['approve', 'reject']);
  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 409]);
  const submission = plain(database.sqlite.prepare('SELECT status, version FROM submissions WHERE id = ?').get('admin-race'));
  const jobs = database.sqlite.prepare('SELECT COUNT(*) AS count FROM publication_jobs WHERE submission_id = ?').get('admin-race').count;
  const media = database.sqlite.prepare('SELECT permission FROM media_assets WHERE id = ?').get('admin-race-media').permission;
  const audits = database.sqlite.prepare("SELECT action, version FROM audit_events WHERE submission_id = 'admin-race' ORDER BY rowid").all().map(plain);
  if (submission.status === 'exporting') {
    assert.equal(jobs, 1);
    assert.equal(media, 'approved');
    assert.deepEqual(audits, [{ action: 'approve', version: 2 }]);
  } else {
    assert.equal(submission.status, 'rejected');
    assert.equal(jobs, 0);
    assert.equal(media, 'pending');
    assert.deepEqual(audits, [{ action: 'reject', version: 2 }]);
  }
  assert.equal(submission.version, 2);
});

test('same-version concurrent approvals produce one job, one permission update, and one audit', async () => {
  const { database, responses } = await runAdminRace(['approve', 'approve']);
  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 409]);
  assert.deepEqual(plain(database.sqlite.prepare('SELECT status, version, write_operation_id FROM submissions WHERE id = ?').get('admin-race')).status, 'exporting');
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM publication_jobs WHERE submission_id = 'admin-race'").get().count, 1);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM media_assets WHERE submission_id = 'admin-race' AND permission = 'approved'").get().count, 1);
  assert.deepEqual(database.sqlite.prepare("SELECT action, version FROM audit_events WHERE submission_id = 'admin-race' ORDER BY rowid").all().map(plain), [{ action: 'approve', version: 2 }]);
});

test('same-version concurrent rejections produce one rejection audit and no publish side effects', async () => {
  const { database, responses } = await runAdminRace(['reject', 'reject']);
  assert.deepEqual(responses.map((response) => response.status).sort((a, b) => a - b), [200, 409]);
  assert.deepEqual(plain(database.sqlite.prepare('SELECT status, version FROM submissions WHERE id = ?').get('admin-race')), { status: 'rejected', version: 2 });
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM publication_jobs WHERE submission_id = 'admin-race'").get().count, 0);
  assert.equal(database.sqlite.prepare("SELECT COUNT(*) AS count FROM media_assets WHERE submission_id = 'admin-race' AND permission = 'approved'").get().count, 0);
  assert.equal(database.sqlite.prepare("SELECT permission FROM media_assets WHERE submission_id = 'admin-race'").get().permission, 'pending');
  assert.deepEqual(database.sqlite.prepare("SELECT action, version FROM audit_events WHERE submission_id = 'admin-race' ORDER BY rowid").all().map(plain), [{ action: 'reject', version: 2 }]);
});

test('a published parent survives a static catalog snapshot change while new and old submissions use their own snapshots', async () => {
  const database = new SqliteD1();
  const runtimeValue = runtime(database);
  const snapshotA = snapshotId(database);
  await withExternalStubs(async (keys) => {
    const parent = await submitV2(runtimeValue, database, 'venue', venuePayload('快照 A 父 venue'), { ip: '198.51.100.20' });
    assert.equal(parent.response.status, 202);
    const oldFood = await submitV2(runtimeValue, database, 'food', foodPayload(), {
      ip: '198.51.100.21',
      body: { parent: { venueEntityId: parent.body.entityId, parentReceiptToken: parent.body.receiptToken } },
    });
    assert.equal(oldFood.response.status, 202);
    assert.equal(database.sqlite.prepare('SELECT snapshot_id FROM submissions WHERE id = ?').get(oldFood.body.submissionId).snapshot_id, snapshotA);

    const snapshotB = publishStaticSnapshotB(database, snapshotA, parent.body.entityId);
    assert.equal(snapshotId(database), snapshotB);
    assert.equal(database.sqlite.prepare('SELECT snapshot_id FROM catalog_mirror WHERE entity_type = \'venue\' AND entity_id = ?').get(parent.body.entityId).snapshot_id, snapshotB);

    const commit = 'd'.repeat(40);
    const jobId = 'snapshot-deploy-job-0001';
    const staged = stageMergedMainJob(database, parent.body.submissionId, jobId, commit);
    const deployed = await deploymentCallback(runtimeValue, { repository: REPOSITORY, commit, contentHash: staged.contentHash, jobId });
    assert.equal(deployed.status, 200, await deployed.clone().text());
    assert.deepEqual(plain(database.sqlite.prepare('SELECT status FROM submissions WHERE id = ?').get(parent.body.submissionId)), { status: 'deployed' });
    assert.deepEqual(plain(database.sqlite.prepare('SELECT publication_state, snapshot_id FROM venues WHERE id = ?').get(parent.body.entityId)), { publication_state: 'published', snapshot_id: snapshotB });

    const newFood = await submitV2(runtimeValue, database, 'food', foodPayload(), {
      ip: '198.51.100.22',
      body: { parent: { venueEntityId: parent.body.entityId } },
    });
    assert.equal(newFood.response.status, 202, JSON.stringify(newFood.body));
    assert.equal(database.sqlite.prepare('SELECT snapshot_id FROM submissions WHERE id = ?').get(newFood.body.submissionId).snapshot_id, snapshotB);

    const newReview = await submitV2(runtimeValue, database, 'review', {
      targetType: 'venue', targetId: parent.body.entityId, rating: 5, text: '快照 B 评价', sources: [source()],
    }, { ip: '198.51.100.23' });
    assert.equal(newReview.response.status, 202, JSON.stringify(newReview.body));
    assert.equal(database.sqlite.prepare('SELECT snapshot_id FROM submissions WHERE id = ?').get(newReview.body.submissionId).snapshot_id, snapshotB);

    const token = await accessToken(keys);
    const approvedOldFood = await worker.fetch(request(`/api/v2/admin/submissions/${oldFood.body.submissionId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token },
      body: JSON.stringify({ action: 'approve', expectedVersion: 1 }),
    }), runtimeValue, {});
    assert.equal(approvedOldFood.status, 200, await approvedOldFood.clone().text());
    assert.deepEqual(plain(database.sqlite.prepare('SELECT status, snapshot_id FROM submissions WHERE id = ?').get(oldFood.body.submissionId)), { status: 'exporting', snapshot_id: snapshotA });
  }, { access: true });
});

test('deployment callback rejects wrong identity, publishes the matching job, and retries idempotently', async () => {
  const database = new SqliteD1();
  const values = { submissionId: 'deploy-submission', entityId: 'deploy-venue', snapshotId: snapshotId(database), status: 'merged_main', publicationState: 'pending' };
  insertBareV2Venue(database, values);
  upsertVenueMirror(database, values.entityId, values.snapshotId, 'b'.repeat(64), '2026-10-01T00:00:00.000Z');
  const commit = 'a'.repeat(40);
  const contentHash = 'b'.repeat(64);
  const now = '2026-10-01T00:00:00.000Z';
  database.sqlite.prepare("UPDATE submissions SET status = 'merged_main' WHERE id = ?").run(values.submissionId);
  const jobId = 'deploy-job-000001';
  database.sqlite.prepare("INSERT INTO publication_jobs (id, submission_id, submission_version, content_hash, status, branch, attempts, main_commit_sha, created_at, updated_at) VALUES (?, ?, 1, ?, 'merged_main', ?, 0, ?, ?, ?)").run(jobId, values.submissionId, contentHash, 'submission/deploy-submission', commit, now, now);
  const runtimeValue = runtime(database);
  const payload = { repository: REPOSITORY, commit, contentHash, jobId };
  const call = async (value) => {
    const body = JSON.stringify(value);
    return worker.fetch(request('/api/v1/webhooks/deploy', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Deploy-Signature': deploySignature(body) }, body }), runtimeValue, {});
  };
  const wrongRepository = await call({ ...payload, repository: 'attacker/repository' });
  assert.equal(wrongRepository.status, 403);
  const wrongCommitShape = await call({ ...payload, commit: 'a'.repeat(39) });
  assert.equal(wrongCommitShape.status, 422);
  const wrongCommit = await call({ ...payload, commit: 'c'.repeat(40) });
  assert.equal(wrongCommit.status, 409, await wrongCommit.clone().text());
  const wrongHash = await call({ ...payload, contentHash: 'd'.repeat(64) });
  assert.equal(wrongHash.status, 409);
  const deployed = await call(payload);
  assert.equal(deployed.status, 200, await deployed.clone().text());
  const retry = await call(payload);
  assert.equal(retry.status, 200);
  assert.equal((await retry.json()).duplicate, true);
  assert.deepEqual(plain(database.sqlite.prepare('SELECT status FROM submissions WHERE id = ?').get(values.submissionId)), { status: 'deployed' });
  assert.deepEqual(plain(database.sqlite.prepare('SELECT status FROM publication_jobs WHERE id = ?').get(jobId)), { status: 'deployed' });
  assert.deepEqual(plain(database.sqlite.prepare('SELECT publication_state FROM venues WHERE id = ?').get(values.entityId)), { publication_state: 'published' });
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS count FROM deployment_callbacks').get().count, 1);
});
