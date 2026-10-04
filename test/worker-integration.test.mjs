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
import { publishLive, editLive, readLive, resumeApproved, maintainLegacyCatalog } from '../src/worker/live-catalog.ts';
import { diningDate } from '../src/utils/dining-date.ts';

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
    if(/^(?:SELECT|WITH)\b/i.test(this.sql.trim()))return {results:this.database.prepare(this.sql).all(...this.values),meta:{changes:0}};
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
    // SQLite's native clock otherwise ignores the Node mock clock used for
    // midnight/expiry tests and can expire their synthetic sessions in real time.
    this.sqlite.function('unixepoch', () => Math.floor(Date.now() / 1000));
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
    IMAGES: fakeR2Bucket(),
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
    async head(key) { return objects.has(key)?{key}:null; },
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

function authenticatedSession(database, id = 1) {
  const now = Math.floor(Date.now() / 1000), token = Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex'), csrf = 'local-csrf-' + id;
  database.sqlite.prepare('INSERT OR IGNORE INTO auth_users(id,issuer,subject,username,created_at,last_login_at) VALUES(?,?,?,?,?,?)').run(id,'https://auth.shoumc.com/api/auth','local-subject-' + id,'同学' + id,now,now);
  database.sqlite.prepare('INSERT INTO auth_sessions(token_hash,user_id,csrf_token,created_at,expires_at) VALUES(?,?,?,?,?)').run(tokenHash,id,csrf,now,now+3600);
  return { id, tokenHash, token, csrf, headers: { Cookie:'__Host-eat-session=' + token, Origin:'https://eat.shoumc.com', 'X-CSRF-Token':csrf } };
}

function finalizeV2(env, receipt, version, headers = {}) {
  return worker.fetch(request('/api/v2/submissions/' + receipt.submissionId + '/finalize', { method:'POST', headers:{'Content-Type':'application/json',Authorization:'Bearer ' + receipt.receiptToken,...headers}, body:JSON.stringify({expectedVersion:version}) }),env,{});
}

test('normal users directly publish no-image food and reviews, with anonymous default and explicit verified username',async()=>{
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'}),user=authenticatedSession(db);
 await withExternalStubs(async()=>{
  const before=await readLive(db),parent=before.catalog.restaurants[0].id;
  const created=await submitV2(env,db,'food',{...foodPayload(),venueId:parent,attachedReview:{rating:4,text:'本地随稿评价'}},{headers:user.headers,body:{expectedImages:0}});
  assert.equal(created.response.status,201,JSON.stringify(created.body));assert.equal(created.body.status,'published');assert.equal(created.body.publicationMode,'direct');assert.equal(created.body.version,2);
  const after=await readLive(db);assert.equal(after.state.revision,before.state.revision+1);assert.ok(after.catalog.foods.some(f=>f.id===created.body.entityId));
  assert.equal(after.catalog.reviews.find(r=>r.targetId===created.body.entityId).authorAlias,null);
  for(const visibility of ['anonymous','username']) {
   const review=await submitV2(env,db,'review',{targetType:'food',targetId:created.body.entityId,rating:5,text:'本地测试',authorAlias:'伪造署名'},{headers:user.headers,body:{visibility}});
   assert.equal(review.response.status,201,JSON.stringify(review.body));
   const published=(await readLive(db)).catalog.reviews.find(r=>r.id===review.body.entityId);assert.equal(published.authorAlias,visibility==='username'?'同学1':null);assert.equal(published.text,'本地测试');
  }
  assert.deepEqual(plain(db.sqlite.prepare('SELECT submitter_user_id,publication_mode,public_author_alias,status FROM submissions WHERE id=?').get(created.body.submissionId)),{submitter_user_id:1,publication_mode:'direct',public_author_alias:null,status:'deployed'});
  const status=await worker.fetch(request('/api/v2/submissions/'+created.body.submissionId+'/status',{headers:{Authorization:'Bearer '+created.body.receiptToken}}),env,{});assert.equal((await status.json()).status,'published');
  const revision=(await readLive(db)).state.revision;
  const retry=await finalizeV2(env,created.body,1,user.headers);assert.equal(retry.status,200);assert.equal((await retry.json()).status,'published');assert.equal((await readLive(db)).state.revision,revision);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE submission_id=? AND action='publish'").get(created.body.submissionId).n,1);
  assert.doesNotMatch(JSON.stringify(after.catalog),/submitter_user_id|receipt_hash|token_hash|local-subject|local-csrf/);
 });
});

test('review date defaults at first creation in UTC+8 and idempotent retries across midnight preserve anonymous identity',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-04T15:59:59.000Z')});
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'}),user=authenticatedSession(db);
 const picture='https://auth.shoumc.com/api/profile/avatar/'+'a'.repeat(64)+'.png';
 db.sqlite.prepare('UPDATE auth_users SET picture=? WHERE id=1').run(picture);
 await withExternalStubs(async()=>{
  const target=(await readLive(db)).catalog.restaurants[0].id,payload={targetType:'venue',targetId:target,rating:4,text:'本地日期测试',authorAlias:'伪造署名'};
  const extra={headers:{...user.headers,'Idempotency-Key':'review-midnight-request'}};
  const first=await submitV2(env,db,'review',payload,extra);assert.equal(first.response.status,201,JSON.stringify(first.body));
  const row=db.sqlite.prepare('SELECT created_at,revision_json,public_author_alias,public_author_avatar,public_identity_recorded FROM submissions WHERE id=?').get(first.body.submissionId);
  assert.equal(JSON.parse(row.revision_json).payload.visitedAt,'2026-10-04');assert.equal(row.public_author_alias,null);assert.equal(row.public_author_avatar,null);assert.equal(row.public_identity_recorded,1);
  assert.equal(diningDate(Date.parse(row.created_at)),'2026-10-04');
  t.mock.timers.tick(2000);assert.equal(diningDate(),'2026-10-05');
  const replay=await submitV2(env,db,'review',payload,extra);assert.equal(replay.response.status,409);assert.equal(replay.body.error.code,'idempotency_replayed');assert.equal(replay.body.submissionId,first.body.submissionId);
  const conflict=await submitV2(env,db,'review',{...payload,visitedAt:'2026-10-05'},extra);assert.equal(conflict.body.error.code,'idempotency_conflict');
  const retry=await finalizeV2(env,first.body,1,user.headers);assert.equal(retry.status,200);assert.equal((await retry.json()).status,'published');
  const response=await worker.fetch(request('/api/v2/public/venue/'+target),env,{}),data=await response.json();
  const published=data.reviews.find(r=>r.id===first.body.entityId);assert.equal(published.visitedAt,'2026-10-04');assert.equal(published.authorAlias,null);assert.equal(published.authorAvatar,null);
  assert.doesNotMatch(JSON.stringify(published),/同学1|avatar\/|local-subject|public_author|submitter_user|userId|csrf|receipt/);
  const future=await submitV2(env,db,'review',{...payload,visitedAt:'9999-12-31'},{headers:user.headers});assert.equal(future.response.status,422);assert.equal(future.body.error.code,'future_visitedAt');assert.match(future.body.error.message,/不能晚于今天/);
 });
});

test('named review snapshots verified username and avatar before photo upload and date remains fixed through later finalization',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-04T04:00:00.000Z')});
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live',MEDIA_MODE:'r2'}),owner=authenticatedSession(db);
 const picture='https://auth.shoumc.com/api/profile/avatar/'+'b'.repeat(64)+'.png';
 db.sqlite.prepare('UPDATE auth_users SET picture=? WHERE id=1').run(picture);
 await withExternalStubs(async()=>{
  const target=(await readLive(db)).catalog.restaurants[0].id,payload={targetType:'venue',targetId:target,rating:5,text:'本地署名照片测试',authorAlias:'伪造署名',visitedAt:'2026-09-30'};
  const first=await submitV2(env,db,'review',payload,{headers:owner.headers,body:{visibility:'username',expectedImages:1}});assert.equal(first.response.status,202,JSON.stringify(first.body));
  assert.equal(db.sqlite.prepare('SELECT public_author_avatar FROM submissions WHERE id=?').get(first.body.submissionId).public_author_avatar,picture);
  t.mock.timers.tick(24*3600000);
  db.sqlite.prepare('UPDATE auth_users SET username=?,picture=? WHERE id=1').run('后来改名','https://auth.shoumc.com/api/profile/avatar/'+'c'.repeat(64)+'.png');
  const renewed=authenticatedSession(db);
  const upload=await worker.fetch(request('/api/v2/submissions/'+first.body.submissionId+'/images',{method:'POST',headers:{...imageUploadHeaders(first.body.receiptToken,0,1),...renewed.headers},body:uploadWebp()}),env,{});assert.equal(upload.status,201,await upload.clone().text());
  const done=await finalizeV2(env,first.body,2,renewed.headers);assert.equal(done.status,200,await done.clone().text());
  const published=(await readLive(db)).catalog.reviews.find(r=>r.id===first.body.entityId);assert.equal(published.authorAlias,'同学1');assert.equal(published.authorAvatar,picture);assert.equal(published.visitedAt,'2026-09-30');
  const revision=(await readLive(db)).state.revision;
  assert.equal((await finalizeV2(env,first.body,2,renewed.headers)).status,200);assert.equal((await readLive(db)).state.revision,revision);
  for(const avatar of [picture,'https://evil.test/avatar.png']) {
   const denied=await submitV2(env,db,'review',{...payload,authorAvatar:avatar},{headers:renewed.headers,body:{visibility:'username'}});assert.equal(denied.response.status,422);assert.equal(denied.body.error.code,'unknown_fields');
  }
 });
});

test('moderated attached reviews retain chosen identity and creation date while legacy unknown dates remain unknown',async t=>{
 t.mock.timers.enable({apis:['Date'],now:Date.parse('2026-10-04T04:00:00.000Z')});
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'}),user=authenticatedSession(db);
 const picture='https://auth.shoumc.com/api/profile/avatar/'+'d'.repeat(64)+'.png';
 db.sqlite.prepare('UPDATE auth_users SET picture=? WHERE id=1').run(picture);
 await withExternalStubs(async()=>{
  const named=await submitV2(env,db,'venue',{...venuePayload(),attachedReview:{rating:4,text:'本地随稿署名'}},{headers:user.headers,body:{visibility:'username'}});assert.equal(named.body.publicationMode,'moderated');
  const anonymous=await submitV2(env,db,'venue',{...venuePayload(),attachedReview:{rating:3,text:'本地匿名随稿',visitedAt:'2026-09-01'}},{headers:user.headers});
  const legacy=await submitV2(env,db,'review',{targetType:'venue',targetId:(await readLive(db)).catalog.restaurants[0].id,rating:4,text:'旧稿夹具'});
  const oldRow=db.sqlite.prepare('SELECT revision_json FROM submissions WHERE id=?').get(legacy.body.submissionId);const oldRevision=JSON.parse(oldRow.revision_json);oldRevision.payload.authorAlias='原有旧署名';oldRevision.payload.visitedAt=null;
  db.sqlite.prepare('UPDATE submissions SET public_identity_recorded=0,revision_json=? WHERE id=?').run(JSON.stringify(oldRevision),legacy.body.submissionId);
  t.mock.timers.tick(24*3600000);
  for(const submission of [named,anonymous,legacy])await publishLive(env,submission.body.submissionId,1,'verified-test-reviewer');
  const catalog=(await readLive(db)).catalog;
  const namedReview=catalog.reviews.find(r=>r.targetId===named.body.entityId);assert.equal(namedReview.authorAlias,'同学1');assert.equal(namedReview.authorAvatar,picture);assert.equal(namedReview.visitedAt,'2026-10-04');
  const anonReview=catalog.reviews.find(r=>r.targetId===anonymous.body.entityId);assert.equal(anonReview.authorAlias,null);assert.equal(anonReview.authorAvatar,null);assert.equal(anonReview.visitedAt,'2026-09-01');
  const oldReview=catalog.reviews.find(r=>r.id===legacy.body.entityId);assert.equal(oldReview.authorAlias,'原有旧署名');assert.equal(oldReview.authorAvatar,undefined);assert.equal(oldReview.visitedAt,null);
 });
});

test('anonymous posts and authenticated venues remain moderated and pending venues cannot be published through food',async()=>{
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'}),user=authenticatedSession(db);
 await withExternalStubs(async()=>{
  const before=await readLive(db),parent=before.catalog.restaurants[0].id;
  const venue=await submitV2(env,db,'venue',venuePayload(),{headers:user.headers});assert.equal(venue.response.status,202);assert.equal(venue.body.publicationMode,'moderated');
  const food=await submitV2(env,db,'food',{...foodPayload(),venueId:parent},{body:{expectedImages:0}});assert.equal(food.body.status,'pending');assert.equal(food.body.publicationMode,'moderated');
  const review=await submitV2(env,db,'review',{targetType:'venue',targetId:parent,rating:4,text:'本地匿名测试'});assert.equal(review.body.status,'pending');
  const retry=await finalizeV2(env,food.body,1,user.headers);assert.equal(retry.status,200);assert.equal((await retry.json()).status,'pending');
  const denied=await submitV2(env,db,'food',{...foodPayload(),venueId:venue.body.entityId},{headers:user.headers,body:{expectedImages:0,parent:{venueEntityId:venue.body.entityId,parentReceiptToken:venue.body.receiptToken}}});
  assert.equal(denied.response.status,409);assert.equal(denied.body.error.code,'parent_venue_unpublished');assert.match(denied.body.error.message,/管理员批准/);
  assert.equal((await readLive(db)).state.revision,before.state.revision);
  assert.ok(!(await readLive(db)).catalog.restaurants.some(v=>v.id===venue.body.entityId));
 });
});

test('direct writes require exact-origin CSRF and the submitting active account even when another user knows the receipt',async()=>{
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live',MEDIA_MODE:'r2'}),owner=authenticatedSession(db),other=authenticatedSession(db,2);
 await withExternalStubs(async()=>{
  const parent=(await readLive(db)).catalog.restaurants[0].id,food={...foodPayload(),venueId:parent};
  for(const headers of [{...owner.headers,'X-CSRF-Token':''},{...owner.headers,Origin:'https://evil.invalid'},{...owner.headers,Origin:''}]) {
   const denied=await submitV2(env,db,'food',food,{headers,body:{expectedImages:0}});assert.equal(denied.response.status,403);assert.equal(denied.body.error.code,'csrf_invalid');
  }
  const created=await submitV2(env,db,'food',food,{headers:owner.headers});assert.equal(created.response.status,202);
  for(const headers of [{},other.headers]) {
   const upload=await worker.fetch(request('/api/v2/submissions/'+created.body.submissionId+'/images',{method:'POST',headers:{...imageUploadHeaders(created.body.receiptToken,0,1),...headers},body:uploadWebp()}),env,{});assert.equal(upload.status,headers.Cookie?403:401);
   assert.equal((await finalizeV2(env,created.body,1,headers)).status,headers.Cookie?403:401);
  }
  db.sqlite.prepare('UPDATE auth_sessions SET expires_at=0 WHERE token_hash=?').run(owner.tokenHash);
  assert.equal((await finalizeV2(env,created.body,1,owner.headers)).status,401);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_assets WHERE submission_id=?').get(created.body.submissionId).n,0);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM catalog_mirror WHERE entity_id=?').get(created.body.entityId).n,0);
  const expired=await submitV2(env,db,'food',food,{headers:owner.headers,body:{expectedImages:0}});assert.equal(expired.body.publicationMode,'moderated');
  const fake=await submitV2(env,db,'food',food,{headers:{Cookie:'__Host-eat-session='+Buffer.alloc(32).toString('base64url'),'X-User-Role':'admin'},body:{expectedImages:0}});assert.equal(fake.body.publicationMode,'moderated');
 });
});

test('direct publication validates image counts, rights and R2 objects before commit and successful finalize retries are idempotent',async()=>{
 const db=new SqliteD1(),bucket=fakeR2Bucket(),env=runtime(db,{CONTENT_MODE:'live',MEDIA_MODE:'r2',IMAGES:bucket}),user=authenticatedSession(db);
 await withExternalStubs(async()=>{
  const parent=(await readLive(db)).catalog.restaurants[0].id;
  const created=await submitV2(env,db,'food',{...foodPayload(),venueId:parent,attachedReview:{rating:3,text:'本地随稿测试'}},{headers:user.headers,body:{expectedImages:1,expectedReviewImages:1}});
  const id=created.body.submissionId,upload=(slot,version,extra={})=>worker.fetch(request('/api/v2/submissions/'+id+'/images',{method:'POST',headers:{...imageUploadHeaders(created.body.receiptToken,0,version),...user.headers,'X-Image-Slot':slot,...extra},body:uploadWebp()}),env,{});
  assert.equal((await finalizeV2(env,created.body,1,user.headers)).status,409);
  assert.equal((await upload('entity',1,{'X-Image-Rights-Confirmed':'false'})).status,422);
  assert.equal((await upload('entity',1,{'X-Image-Is-Illustrative':'true'})).status,422);
  const first=await upload('entity',1);assert.equal(first.status,201);const asset=(await first.json()).assetId;
  assert.equal((await finalizeV2(env,created.body,2,user.headers)).status,409);
  assert.equal((await worker.fetch(request('/media/'+asset+'.webp'),env,{})).status,404);
  assert.equal((await upload('attachedReview',2)).status,201);
  const saved=bucket.objects.get('media/'+asset+'.webp');bucket.objects.delete('media/'+asset+'.webp');
  const missing=await finalizeV2(env,created.body,3,user.headers);assert.equal(missing.status,409);assert.equal((await missing.json()).error.code,'media_object_missing');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM catalog_mirror WHERE entity_id=?').get(created.body.entityId).n,0);
  bucket.objects.set('media/'+asset+'.webp',saved);
  const version=db.sqlite.prepare('SELECT version FROM submissions WHERE id=?').get(id).version;
  const done=await finalizeV2(env,created.body,version,user.headers);assert.equal(done.status,200,await done.clone().text());const published=await done.json();assert.equal(published.status,'published');
  assert.equal((await worker.fetch(request('/media/'+asset+'.webp'),env,{})).status,200);
  assert.equal((await readLive(db)).catalog.reviews.find(r=>r.targetId===created.body.entityId).authorAlias,null);
  const revision=(await readLive(db)).state.revision,retry=await finalizeV2(env,created.body,version,user.headers);assert.equal(retry.status,200);assert.equal((await retry.json()).version,published.version);assert.equal((await readLive(db)).state.revision,revision);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE submission_id=? AND action='publish'").get(id).n,1);
 });
});

test('direct idempotency and rate limits follow the account across changing IP addresses',async()=>{
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'}),user=authenticatedSession(db);
 await withExternalStubs(async()=>{
  const parent=(await readLive(db)).catalog.restaurants[0].id,food={...foodPayload(),venueId:parent},headers={...user.headers,'Idempotency-Key':'local-idempotency-stable'};
  const created=await submitV2(env,db,'food',food,{headers,body:{expectedImages:0}});assert.equal(created.response.status,201);
  const revision=(await readLive(db)).state.revision;
  const replay=await submitV2(env,db,'food',food,{headers,ip:'198.51.100.11',body:{expectedImages:0}});assert.equal(replay.response.status,409);assert.equal(replay.body.error.code,'idempotency_replayed');assert.equal((await readLive(db)).state.revision,revision);
  const different=await submitV2(env,db,'food',{...food,name:'不同稿件'},{headers,body:{expectedImages:0}});assert.equal(different.body.error.code,'idempotency_conflict');
  for(let i=1;i<5;i++)assert.equal((await submitV2(env,db,'food',{...food,name:'本地限频'+i},{headers:user.headers,ip:'198.51.100.'+(20+i),body:{expectedImages:0}})).response.status,201);
  assert.equal((await submitV2(env,db,'food',food,{headers:user.headers,ip:'198.51.100.99',body:{expectedImages:0}})).response.status,429);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM submissions WHERE submitter_user_id=1').get().n,5);
 });
});

test('logout during R2 processing and failed publish auditing cannot commit partial authenticated writes',async()=>{
 const db=new SqliteD1(),bucket=fakeR2Bucket(),env=runtime(db,{CONTENT_MODE:'live',MEDIA_MODE:'r2',IMAGES:bucket});let user=authenticatedSession(db);
 await withExternalStubs(async()=>{
  const parent=(await readLive(db)).catalog.restaurants[0].id,food={...foodPayload(),venueId:parent};
  const created=await submitV2(env,db,'food',food,{headers:user.headers}),id=created.body.submissionId;
  const originalPut=bucket.put;
  bucket.put=async(...args)=>{await originalPut(...args);db.sqlite.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(user.tokenHash);};
  const upload=()=>worker.fetch(request('/api/v2/submissions/'+id+'/images',{method:'POST',headers:{...imageUploadHeaders(created.body.receiptToken,0,1),...user.headers},body:uploadWebp()}),env,{});
  assert.equal((await upload()).status,409);
  assert.deepEqual(plain(db.sqlite.prepare('SELECT version,upload_state FROM submissions WHERE id=?').get(id)),{version:1,upload_state:'uploading'});
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM media_assets WHERE submission_id=?').get(id).n,0);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM media_reservations WHERE submission_id=? AND state='orphan'").get(id).n,1);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM audit_events WHERE submission_id=? AND action='image_upload'").get(id).n,0);
  bucket.put=originalPut;user=authenticatedSession(db);
  assert.equal((await upload()).status,201);
  const originalHead=bucket.head,revision=(await readLive(db)).state.revision;
  bucket.head=async(...args)=>{const result=await originalHead(...args);db.sqlite.prepare('DELETE FROM auth_sessions WHERE token_hash=?').run(user.tokenHash);return result;};
  assert.equal((await finalizeV2(env,created.body,2,user.headers)).status,503);
  assert.equal((await readLive(db)).state.revision,revision);assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM catalog_mirror WHERE entity_id=?').get(created.body.entityId).n,0);
  bucket.head=originalHead;user=authenticatedSession(db);
  db.sqlite.exec("CREATE TRIGGER local_fail_publish BEFORE INSERT ON audit_events WHEN NEW.action='publish' BEGIN SELECT RAISE(ABORT,'local failure'); END;");
  const readyVersion=db.sqlite.prepare('SELECT version FROM submissions WHERE id=?').get(id).version;
  assert.equal((await finalizeV2(env,created.body,readyVersion,user.headers)).status,503);assert.equal((await readLive(db)).state.revision,revision);
  assert.equal(db.sqlite.prepare("SELECT COUNT(*) n FROM media_assets WHERE submission_id=? AND object_state='published'").get(id).n,0);
  db.sqlite.exec('DROP TRIGGER local_fail_publish');
  assert.equal((await finalizeV2(env,created.body,readyVersion,user.headers)).status,200);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM live_write_assertion').get().n,0);
 });
});

test('anonymous session reads stay available and user names, roles or fields cannot request publication authority',async()=>{
 const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'});
 const session=await worker.fetch(request('/auth/session'),env,{});assert.equal(session.status,200);assert.equal((await session.json()).user,null);
 await withExternalStubs(async()=>{
  const parent=(await readLive(db)).catalog.restaurants[0].id;
  for(const extra of [{publicationMode:'direct'},{submitterUserId:1},{visibility:'forged-name'},{roles:['admin']}]) {
   const denied=await submitV2(env,db,'food',{...foodPayload(),venueId:parent},{body:{expectedImages:0,...extra}});assert.equal(denied.response.status,422);
  }
  const unsigned=await submitV2(env,db,'review',{targetType:'venue',targetId:parent,rating:4,text:'测试'},{body:{visibility:'username'}});assert.equal(unsigned.response.status,401);
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) n FROM submissions').get().n,0);
 });
});

async function submitV2(runtimeValue, database, entityType, payload, extra = {}) {
  const response = await worker.fetch(request('/api/v2/submissions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': extra.ip ?? '198.51.100.10', ...(extra.headers ?? {}) },
    body: JSON.stringify({ schemaVersion: 2, entityType, snapshotId: snapshotId(database), payload, expectedImages: entityType==='food'?1:0, expectedReviewImages: 0, turnstileToken: 'turnstile-token', ...extra.body }),
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

test('live approval publishes catalog and attached rating atomically without GitHub',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live',GITHUB_APP_ID:'',GITHUB_PRIVATE_KEY:''});
  await withExternalStubs(async keys=>{
    const submitted=await submitV2(env,db,'venue',{...venuePayload('即时公开店铺'),attachedReview:{rating:5,text:'真实评价'}},{body:{snapshotId:'current'}});
    assert.equal(submitted.response.status,202,JSON.stringify(submitted.body));
    const catalog=()=>worker.fetch(request('/api/v2/public/catalog'),env,{}).then(r=>r.json());
    assert.ok(!(await catalog()).venues.some(v=>v.id===submitted.body.entityId));
    const token=await accessToken(keys);
    const approve=headers=>worker.fetch(request('/api/v2/admin/submissions/'+submitted.body.submissionId+'/review',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify({action:'approve',expectedVersion:1})}),env,{});
    assert.equal((await approve({})).status,401);
    const response=await approve({'Cf-Access-Jwt-Assertion':token});
    assert.equal(response.status,200,await response.clone().text());
    assert.equal((await response.json()).status,'published');
    const item=(await catalog()).venues.find(v=>v.id===submitted.body.entityId);
    assert.equal(item.name,'即时公开店铺');assert.equal(item.rating,5);
    assert.equal((await approve({'Cf-Access-Jwt-Assertion':token})).status,409);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM publication_jobs').get().n,0);
    assert.equal(db.sqlite.prepare('SELECT revision FROM live_catalog_state').get().revision,2);
    const detail=await worker.fetch(request('/api/v2/public/venue/'+item.id),env,{}).then(r=>r.json());
    assert.equal(detail.reviews[0].text,'真实评价');
    assert.ok(!JSON.stringify(detail).includes(submitted.body.receiptToken));
  },{access:true});
});

test('catalog ETag checks one authoritative revision and changes immediately with atomic publication and management',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live',MEDIA_MODE:'r2'}),user=authenticatedSession(db);
  const reads=[],prepare=db.prepare.bind(db);db.prepare=sql=>{reads.push(sql);return prepare(sql);};
  const catalog=etag=>worker.fetch(request('/catalog-index.json',{headers:etag?{'If-None-Match':etag}:{}}),env,{});
  let response=await catalog(),etag=response.headers.get('ETag');
  assert.equal(response.status,200);assert.ok(etag);assert.equal(response.headers.get('Cache-Control'),'no-store');
  reads.length=0;response=await catalog(etag);
  assert.equal(response.status,304);assert.equal(await response.text(),'');assert.equal(response.headers.get('ETag'),etag);
  assert.deepEqual(reads,['SELECT revision FROM live_catalog_state WHERE id=1']);
  const expectChanged=async()=>{
    const changed=await catalog(etag);assert.equal(changed.status,200);assert.notEqual(changed.headers.get('ETag'),etag);
    const data=await changed.json();etag=changed.headers.get('ETag');assert.equal(etag,`"eat-catalog-v1-${data.revision}"`);
    return data;
  };
  await withExternalStubs(async()=>{
    const parents=(await readLive(db)).catalog.restaurants.slice(0,2);
    const submitted=await submitV2(env,db,'food',{...foodPayload(),venueId:parents[0].id},{headers:user.headers,body:{expectedImages:1}});
    assert.equal(submitted.response.status,202,JSON.stringify(submitted.body));
    const receipt=submitted.body;
    response=await worker.fetch(request(`/api/v2/submissions/${receipt.submissionId}/images`,{method:'POST',headers:{...imageUploadHeaders(receipt.receiptToken,0,1),...user.headers},body:uploadWebp()}),env,{});
    assert.equal(response.status,201,await response.clone().text());
    response=await finalizeV2(env,receipt,2,user.headers);assert.equal(response.status,200,await response.clone().text());
    assert.ok((await expectChanged()).foods.some(food=>food.id===receipt.entityId));
    const edit=async transform=>{
      const entry=(await readLive(db)).entries.find(entry=>entry.type==='food'&&entry.record.id===receipt.entityId);
      await editLive(env,'food',entry.record.id,{expectedHash:entry.hash,record:transform(entry.record),reason:'本地 ETag 回归'},'reviewer');
      return expectChanged();
    };
    let data=await edit(record=>({...record,venueId:parents[1].id}));
    assert.equal(data.foods.find(food=>food.id===receipt.entityId).venueId,parents[1].id);
    await edit(record=>({...record,cover:{url:record.images[0].url,reviewId:null,x:25,y:75}}));
    await edit(record=>({...record,cover:null,images:record.images.map(image=>({...image,hidden:true}))}));
    data=await edit(record=>({...record,status:'archived'}));assert.ok(!data.foods.some(food=>food.id===receipt.entityId));
    data=await edit(record=>({...record,status:'published'}));assert.ok(data.foods.some(food=>food.id===receipt.entityId));
    reads.length=0;response=await catalog(etag);assert.equal(response.status,304);assert.equal(reads.length,1);
    const entry=(await readLive(db)).entries.find(entry=>entry.record.id===receipt.entityId);
    db.sqlite.exec("CREATE TRIGGER fail_etag_test BEFORE UPDATE ON foods BEGIN SELECT RAISE(ABORT,'forced failure'); END");
    await assert.rejects(editLive(env,'food',entry.record.id,{expectedHash:entry.hash,record:{...entry.record,name:'不应公开'},reason:'回滚'},'reviewer'));
    response=await catalog(etag);assert.equal(response.status,304,'failed transaction must preserve both data and revision');
  });
});

test('live media is private before commit and hidden or archived photos stop serving',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live',MEDIA_MODE:'r2'});
  await withExternalStubs(async()=>{
    const submitted=await submitV2(env,db,'venue',venuePayload(),{body:{expectedImages:1}});
    const receipt=submitted.body;
    const uploaded=await worker.fetch(request(`/api/v2/submissions/${receipt.submissionId}/images`,{method:'POST',headers:imageUploadHeaders(receipt.receiptToken,0,1),body:uploadWebp()}),env,{});
    assert.equal(uploaded.status,201,await uploaded.clone().text());
    const media=db.sqlite.prepare('SELECT id FROM media_assets WHERE submission_id=?').get(receipt.submissionId);
    const read=()=>worker.fetch(request(`/media/${media.id}.webp`),env,{});
    assert.equal((await read()).status,404);
    const finalized=await worker.fetch(request(`/api/v2/submissions/${receipt.submissionId}/finalize`,{method:'POST',headers:{Authorization:`Bearer ${receipt.receiptToken}`,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:2,expectedImages:1,expectedReviewImages:0})}),env,{});
    assert.equal(finalized.status,200,await finalized.clone().text());
    await publishLive(env,receipt.submissionId,3,'reviewer');
    assert.equal((await read()).status,200);
    let entry=(await readLive(db)).entries.find(e=>e.record.id===receipt.entityId);
    await editLive(env,'venue',entry.record.id,{expectedHash:entry.hash,record:{...entry.record,images:entry.record.images.map(i=>({...i,hidden:true}))},reason:'隐藏照片'},'reviewer');
    assert.equal((await read()).status,404);
    entry=(await readLive(db)).entries.find(e=>e.record.id===receipt.entityId);
    await editLive(env,'venue',entry.record.id,{expectedHash:entry.hash,record:{...entry.record,status:'archived'},reason:'下架'},'reviewer');
    assert.equal((await worker.fetch(request('/api/v2/public/venue/'+receipt.entityId),env,{})).status,404);
  });
});

test('live optimistic edits reject stale versions and roll back all records on failure',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'});
  const original=(await readLive(db)).entries.find(e=>e.type==='food');
  const edited={...original.record,name:'数据库新名称'};
  await editLive(env,'food',edited.id,{expectedHash:original.hash,record:edited,reason:'更新名称'},'reviewer');
  await assert.rejects(()=>editLive(env,'food',edited.id,{expectedHash:original.hash,record:edited,reason:'过期修改'},'reviewer'),/revision_conflict/);
  const current=(await readLive(db)).entries.find(e=>e.record.id===edited.id),version=(await readLive(db)).state.revision;
  // Force a late batch failure: the prior mirror, history and global revision
  // must all remain unchanged instead of exposing a partially edited record.
  db.sqlite.exec("CREATE TRIGGER fail_live_test BEFORE UPDATE ON foods BEGIN SELECT RAISE(ABORT,'forced failure'); END");
  await assert.rejects(()=>editLive(env,'food',edited.id,{expectedHash:current.hash,record:{...current.record,name:'不可见名称'},reason:'失败'},'reviewer'));
  const after=await readLive(db);
  assert.equal(after.state.revision,version);
  assert.equal(after.entries.find(e=>e.record.id===edited.id).record.name,'数据库新名称');
  assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS n FROM live_write_assertion').get().n,0);
});

test('backup requires scoped expiring signature and only exports released canonical content',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'});
  insertBareV2Venue(db,{submissionId:'private-id',entityId:'private-venue',name:'私有未审核名称',snapshotId:snapshotId(db)});
  const call=async(path,method='GET',value,stamp=String(Date.now()))=>{
    const body=value?JSON.stringify(value):'';
    const signature=createHmac('sha256',DEPLOY_SECRET).update(`backup-v1\n${stamp}\n${method}\n${path}\n${body}`).digest('hex');
    return worker.fetch(request(path,{method,headers:{'X-Backup-Timestamp':stamp,'X-Backup-Signature':signature,'Content-Type':'application/json'},...(body?{body}:{})}),env,{});
  };
  assert.equal((await worker.fetch(request('/api/v2/backup/export'),env,{})).status,401);
  assert.equal((await call('/api/v2/backup/export','GET',null,'1000000000000')).status,401);
  const exported=await call('/api/v2/backup/export');assert.equal(exported.status,200);
  const data=await exported.json();
  assert.ok(!JSON.stringify(data).includes('私有未审核名称'));
  assert.ok(!JSON.stringify(data).includes('receipt-private-id'));
  assert.equal(sha256Hex(JSON.stringify(data.snapshot)),data.contentHash);
  const ack={revision:data.snapshot.revision,contentHash:data.contentHash,commit:'a'.repeat(40)};
  assert.equal((await (await call('/api/v2/backup/ack','POST',{...ack,contentHash:'bad'})).json()).acknowledged,false);
  assert.equal((await (await call('/api/v2/backup/ack','POST',ack)).json()).acknowledged,true);
  assert.equal(db.sqlite.prepare('SELECT backed_revision FROM live_catalog_state').get().backed_revision,1);
});

test('live cutover resumes approved legacy submissions and ignores old deployment callbacks',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'});
  insertBareV2Venue(db,{submissionId:'legacy-approved',entityId:'legacy-approved-venue',snapshotId:snapshotId(db),status:'exporting'});
  await resumeApproved(env);
  assert.ok((await readLive(db)).entries.some(e=>e.record.id==='legacy-approved-venue'));
  await resumeApproved(env);
  assert.equal((await readLive(db)).state.revision,2);
  const response=await worker.fetch(request('/api/v1/webhooks/deploy',{method:'POST',body:'old callback'}),env,{});
  assert.equal(response.status,202);assert.equal((await readLive(db)).state.revision,2);
});

test('ordinary deployments never execute the repository seed against remote D1',()=>{
  const pkg=JSON.parse(readFileSync(join(root,'package.json'),'utf8'));
  for(const key of ['worker:deploy:production','worker:deploy:preview']){
    assert.ok(!pkg.scripts[key].includes('seed.sql'));
    assert.ok(pkg.scripts[key].includes('migrations apply'));
  }
});

test('live food upload, reparent, archive and restore update public links immediately',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live',MEDIA_MODE:'r2'});
  await withExternalStubs(async()=>{
    const initial=await readLive(db),parents=initial.entries.filter(e=>e.type==='venue').slice(0,2);
    const submitted=await submitV2(env,db,'food',foodPayload(),{body:{parent:{venueEntityId:parents[0].record.id}}});
    assert.equal(submitted.response.status,202,JSON.stringify(submitted.body));
    const r=submitted.body;
    let response=await worker.fetch(request(`/api/v2/submissions/${r.submissionId}/images`,{method:'POST',headers:imageUploadHeaders(r.receiptToken,0,1),body:uploadWebp()}),env,{});
    assert.equal(response.status,201,await response.clone().text());
    response=await worker.fetch(request(`/api/v2/submissions/${r.submissionId}/finalize`,{method:'POST',headers:{Authorization:`Bearer ${r.receiptToken}`,'Content-Type':'application/json'},body:JSON.stringify({expectedVersion:2,expectedImages:1,expectedReviewImages:0})}),env,{});
    assert.equal(response.status,200);
    await publishLive(env,r.submissionId,3,'reviewer');
    let current=await readLive(db),food=current.entries.find(e=>e.record.id===r.entityId);
    assert.ok(current.entries.find(e=>e.record.id===parents[0].record.id).record.foods.includes(r.entityId));
    assert.equal(food.record.sources[0].repository,'integration');
    await editLive(env,'food',r.entityId,{expectedHash:food.hash,record:{...food.record,venueId:parents[1].record.id},reason:'修正所属店铺'},'reviewer');
    current=await readLive(db);food=current.entries.find(e=>e.record.id===r.entityId);
    assert.ok(!current.entries.find(e=>e.record.id===parents[0].record.id).record.foods.includes(r.entityId));
    assert.ok(current.entries.find(e=>e.record.id===parents[1].record.id).record.foods.includes(r.entityId));
    await editLive(env,'food',r.entityId,{expectedHash:food.hash,record:{...food.record,status:'archived'},reason:'暂时下架'},'reviewer');
    assert.equal((await worker.fetch(request('/api/v2/public/food/'+r.entityId),env,{})).status,404);
    food=(await readLive(db)).entries.find(e=>e.record.id===r.entityId);
    await editLive(env,'food',r.entityId,{expectedHash:food.hash,record:{...food.record,status:'published'},reason:'恢复'},'reviewer');
    assert.equal((await worker.fetch(request('/api/v2/public/food/'+r.entityId),env,{})).status,200);
  });
});

test('retired static detail variants cannot expose archived content',async()=>{
  const db=new SqliteD1(),env=runtime(db,{CONTENT_MODE:'live'}),food=(await readLive(db)).entries.find(e=>e.type==='food');
  await editLive(env,'food',food.record.id,{expectedHash:food.hash,record:{...food.record,status:'archived'},reason:'下架'},'reviewer');
  for(const suffix of ['/', '/index.html','/extra'])assert.equal((await worker.fetch(request('/foods/'+food.record.id+suffix),env,{})).status,404);
});

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
    assert.deepEqual(await finalized.json(), { submissionId: created.body.submissionId, entityId: created.body.entityId, status: 'pending', uploadState: 'pending', publicationMode: 'moderated', version: 4, uploadedImages: 2, uploadedReviewImages: 0 });
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
    runtimeValue.MEDIA_MODE = 'r2';
    const uploadedFood = await worker.fetch(request(`/api/v2/submissions/${oldFood.body.submissionId}/images`,{method:'POST',headers:imageUploadHeaders(oldFood.body.receiptToken,0,1),body:uploadWebp()}),runtimeValue,{});
    assert.equal(uploadedFood.status,201,await uploadedFood.clone().text());
    const finalizedFood = await worker.fetch(request(`/api/v2/submissions/${oldFood.body.submissionId}/finalize`,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${oldFood.body.receiptToken}`},body:JSON.stringify({expectedVersion:2})}),runtimeValue,{});
    assert.equal(finalizedFood.status,200);
    const approvedOldFood = await worker.fetch(request(`/api/v2/admin/submissions/${oldFood.body.submissionId}/review`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Cf-Access-Jwt-Assertion': token },
      body: JSON.stringify({ action: 'approve', expectedVersion: 3 }),
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


test('content management requires Access, checks CAS and dependencies, and publishes through audited jobs', async()=>{
 const database=new SqliteD1();const env=runtime(database);
 const unauth=await worker.fetch(request('/api/v2/admin/content'),env,{});assert.equal(unauth.status,401);
 await withExternalStubs(async keys=>{
  const token=await accessToken(keys),headers={'Content-Type':'application/json','Cf-Access-Jwt-Assertion':token};
  const listing=await worker.fetch(request('/api/v2/admin/content',{headers}),env,{});assert.equal(listing.status,200);
  const data=await listing.json();const entry=data.entries.find(e=>e.type==='food');const parent=data.entries.find(e=>e.type==='venue'&&e.record.id===entry.record.venueId);
  const edit=(target,record,extra={})=>worker.fetch(request('/api/v2/admin/content/'+target.type+'/'+target.record.id,{method:'POST',headers,body:JSON.stringify({expectedHash:target.hash,record,reason:'集成测试维护',...extra})}),env,{});
  assert.equal((await edit(entry,{...entry.record,name:'新名称'},{expectedHash:'stale'})).status,409);
  assert.equal((await edit(parent,{...parent.record,status:'archived'})).status,422);
  assert.equal((await edit(entry,{...entry.record,id:'other'})).status,422);
  const forbidden=await worker.fetch(request('/api/v2/admin/content/'+entry.type+'/'+entry.record.id,{method:'POST',headers:{...headers,Origin:'https://evil.example'},body:'{}'}),env,{});assert.equal(forbidden.status,403);
  const saved=await edit(entry,{...entry.record,name:'集成测试新名称'});assert.equal(saved.status,202,await saved.clone().text());const receipt=await saved.json();
  assert.equal((await edit(entry,{...entry.record,name:'重复'})).status,409);
  const submission=database.sqlite.prepare('SELECT * FROM submissions WHERE id=?').get(receipt.submissionId);
  assert.equal(submission.entity_type,'management');assert.equal(submission.status,'exporting');assert.equal(JSON.parse(submission.revision_json).record.name,'集成测试新名称');
  assert.equal(database.sqlite.prepare('SELECT COUNT(*) AS n FROM audit_events WHERE submission_id=?').get(receipt.submissionId).n,1);
  assert.equal(database.sqlite.prepare('SELECT name FROM foods WHERE id=?').get(entry.record.id).name,entry.record.name);
  // Failed changes can be cancelled; a live PR cannot. Cancellation unlocks the entity.
  const cancel=()=>worker.fetch(request('/api/v2/admin/content-changes/'+receipt.publicationJobId+'/cancel',{method:'POST',headers}),env,{});
  assert.equal((await cancel()).status,409);
  database.sqlite.prepare("UPDATE publication_jobs SET status='failed',error_code='catalog_revision_conflict' WHERE id=?").run(receipt.publicationJobId);
  database.sqlite.prepare("UPDATE submissions SET status='export_failed' WHERE id=?").run(receipt.submissionId);
  assert.equal((await cancel()).status,200);
  assert.equal((await worker.fetch(request('/api/v2/admin/publications/'+receipt.publicationJobId+'/retry',{method:'POST',headers}),env,{})).status,409);
  const next=await edit(entry,{...entry.record,status:'archived'});assert.equal(next.status,202);
  const nextReceipt=await next.json();const commit='f'.repeat(40);const staged={contentHash:database.sqlite.prepare('SELECT content_hash FROM publication_jobs WHERE id=?').get(nextReceipt.publicationJobId).content_hash};database.sqlite.prepare("UPDATE publication_jobs SET status='merged_main',main_commit_sha=? WHERE id=?").run(commit,nextReceipt.publicationJobId);database.sqlite.prepare("UPDATE submissions SET status='merged_main' WHERE id=?").run(nextReceipt.submissionId);
  const callback=await deploymentCallback(env,{repository:REPOSITORY,commit,contentHash:staged.contentHash,jobId:nextReceipt.publicationJobId});assert.equal(callback.status,200,await callback.clone().text());
 },{access:true});
});

test('new food cannot bypass actual upload completion or submit an illustrative image',async()=>{
 const database=new SqliteD1(),env=runtime(database,{MEDIA_MODE:'r2'});
 await withExternalStubs(async()=>{
  const parent=database.sqlite.prepare("SELECT id FROM venues WHERE publication_state='published' LIMIT 1").get().id;
  const absent=await submitV2(env,database,'food',{...foodPayload(),venueId:parent},{body:{expectedImages:0}});assert.equal(absent.response.status,202);assert.equal(absent.body.expectedImages,0);
  const submitted=await submitV2(env,database,'food',{...foodPayload(),venueId:parent});assert.equal(submitted.response.status,202);
  const id=submitted.body.submissionId;
  const finalize=await worker.fetch(request('/api/v2/submissions/'+id+'/finalize',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+submitted.body.receiptToken},body:JSON.stringify({expectedVersion:1})}),env,{});assert.equal(finalize.status,409);
  const photo=await worker.fetch(request('/api/v2/submissions/'+id+'/images',{method:'POST',headers:{...imageUploadHeaders(submitted.body.receiptToken,0,1),'X-Image-Is-Illustrative':'true'},body:uploadWebp()}),env,{});assert.equal(photo.status,422);assert.equal((await photo.json()).error.code,'food_photo_must_be_real');
 });
});

 test('legacy maintenance archives only explicit imported foods, keeps venues and submissions, and is resumable',async()=>{
 const database=new SqliteD1(),env=runtime(database,{CONTENT_MODE:'live'});
 const before=await readLive(database);const venueCount=before.catalog.restaurants.length;
 let result;do{result=await maintainLegacyCatalog(env,'reviewer@example.com');}while(result.remaining);
 const after=await readLive(database);
 assert.equal(after.catalog.restaurants.filter(v=>v.status!=='archived').length,venueCount);
 assert.equal(after.catalog.foods.filter(f=>f.status==='archived').length,45);
 const real=after.catalog.foods.filter(f=>f.status!=='archived');assert.ok(real.every(f=>f.sources.some(s=>s.path.startsWith('submissions/'))));
 assert.ok(after.catalog.foods.every(f=>f.tags.every(t=>/\p{Script=Han}/u.test(t))));
 const revision=after.state.revision;assert.equal((await maintainLegacyCatalog(env,'reviewer@example.com')).changed,0);assert.equal((await readLive(database)).state.revision,revision);
 const response=await worker.fetch(request('/api/v2/admin/maintenance/legacy-catalog',{method:'POST'}),env,{});assert.equal(response.status,401);
 });
