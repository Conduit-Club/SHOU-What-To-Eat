import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { PUBLIC_DETAIL_SQL, readPublicDetail } from '../src/worker/public-detail.ts';
import { LIVE_RESUME_SQL, readLive } from '../src/worker/live-catalog.ts';
import { publicCatalog } from '../src/lib/catalog/visibility.ts';

const migrationDirectory = new URL('../migrations/', import.meta.url);
const queryMigration = readFileSync(new URL('0012_query_indexes.sql', migrationDirectory), 'utf8');
class LocalD1 {
  constructor(indexes = true) {
    this.sqlite = new DatabaseSync(':memory:');
    this.reads = [];
    this.sqlite.exec('PRAGMA foreign_keys=ON');
    for (const name of readdirSync(migrationDirectory).filter(name => name.endsWith('.sql') && (indexes || !name.startsWith('0012'))).sort()) {
      this.sqlite.exec(readFileSync(new URL(name, migrationDirectory), 'utf8'));
    }
    this.sqlite.exec("INSERT INTO catalog_snapshots(id,content_hash,generated_at,status) VALUES('fixture','fixture','2026-10-04','published')");
  }
  prepare(sql) {
    const database = this;
    const statement = values => ({
      sql, values, bind: (...bindings) => statement(bindings),
      first: async () => database.sqlite.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: database.select(sql, values) }),
    });
    return statement([]);
  }
  select(sql, values) { const rows = this.sqlite.prepare(sql).all(...values); this.reads.push({ sql, count: rows.length }); return rows; }
  async batch(statements) {
    this.sqlite.exec('BEGIN');
    try { const result = statements.map(({ sql, values }) => ({ results: this.select(sql, values) })); this.sqlite.exec('COMMIT'); return result; }
    catch (error) { this.sqlite.exec('ROLLBACK'); throw error; }
  }
  put(type, record) {
    this.sqlite.prepare('INSERT INTO catalog_mirror(entity_type,entity_id,snapshot_id,payload_json,content_hash,synced_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET payload_json=excluded.payload_json').run(type,record.id,'fixture',JSON.stringify(record),'fixture','2026-10-04');
  }
}
const dates = { addedAt: null, visitedAt: null, verifiedAt: null, updatedAt: null };
const sources = [{ repository:'local-query-test', path:'synthetic.json', revision:'fixture', license:null }];
const image = { url:'https://example.test/real.webp', alt:'本地合成照片', sourceUrl:'https://example.test/source', license:'本地测试授权', permission:'approved', isIllustrative:false, coverEligible:true };
const venue = (id, extra = {}) => ({ schemaVersion:2, id, name:id, kind:'stall', category:'on-campus', location:{address:'本地合成地址'}, foods:[], images:[], sources, dates, ...extra });
const food = (id, parent, extra = {}) => ({ schemaVersion:2, id, name:id, venueId:parent, images:[], sources, dates, ...extra });
const review = (id, type, target, extra = {}) => ({ schemaVersion:2, id, targetType:type, targetId:target, rating:4, text:'本地合成评价', images:[], sources, ...extra });
function fixture(database) {
  database.put('venue',venue('parent',{foods:['target','sibling','archived-food'],cover:{url:image.url,reviewId:'venue-cover'}}));
  database.put('food',food('target','parent',{images:[{...image,url:'https://example.test/own.webp'}],cover:{url:image.url,reviewId:'target-review'}}));
  database.put('food',food('sibling','parent',{cover:{url:image.url,reviewId:'sibling-cover'}}));
  database.put('food',food('archived-food','parent',{status:'archived'}));
  database.put('review',review('target-review','food','target',{images:[image]}));
  database.put('review',review('target-hidden','food','target',{images:[{...image,hidden:true}]}));
  database.put('review',review('target-archived','food','target',{status:'archived'}));
  database.put('review',review('venue-cover','venue','parent',{images:[image]}));
  database.put('review',review('sibling-cover','food','sibling',{images:[image]}));
  for(let i=0;i<20;i++) { database.put('venue',venue('unrelated-'+i)); database.put('review',review('unrelated-review-'+i,'venue','unrelated-'+i)); }
}
async function assertEquivalent(database, type, id) {
  const before = publicCatalog((await readLive(database)).catalog);
  database.reads = [];
  const detail = await readPublicDetail(database,type,id);
  const record = (type === 'food' ? before.foods : before.restaurants).find(row => row.id === id);
  assert.deepEqual(detail.record,record);
  assert.deepEqual(detail.reviews,before.reviews.filter(row => row.targetType === type && row.targetId === id));
  assert.deepEqual(detail.venue,type === 'food' && record ? before.restaurants.find(row => row.id === record.venueId) ?? null : null);
  assert.deepEqual(detail.foods,type === 'venue' ? before.foods.filter(row => row.venueId === id) : []);
  assert.equal(database.reads.length,2);
  assert.ok(database.reads[1].count <= 8, 'details must not return unrelated catalog records');
}

test('scoped food and venue details preserve canonical public links, reviews and covers without the full catalog',async t => {
  const db = new LocalD1(); t.after(() => db.sqlite.close()); fixture(db);
  assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM venues').get().n,0,'normalized tables are not public authority');
  for(const target of [['food','target'],['venue','parent'],['food','archived-food'],['food','missing']]) await assertEquivalent(db,...target);
  for(const change of [{status:'archived'},{images:[{...image,hidden:true}]},{images:[{...image,coverEligible:false}]},{images:[{...image,isIllustrative:true}]},{targetId:'sibling'}]) {
    db.put('review',review('target-review','food','target',{images:[image],...change}));
    await assertEquivalent(db,'food','target');
  }
  db.put('venue',venue('parent',{status:'archived',foods:['target','sibling']}));
  await assertEquivalent(db,'food','target'); await assertEquivalent(db,'venue','parent');
});

test('detail relationship lookups use the two public JSON indexes and primary keys',t => {
  const db = new LocalD1(); t.after(() => db.sqlite.close()); fixture(db);
  const plan = db.sqlite.prepare('EXPLAIN QUERY PLAN '+PUBLIC_DETAIL_SQL).all('food','target','food','target').map(row=>row.detail).join('\n');
  assert.match(plan,/SEARCH catalog_mirror USING INDEX idx_catalog_public_food_venue/);
  assert.match(plan,/SEARCH catalog_mirror USING INDEX idx_catalog_public_review_target/);
  assert.match(plan,/SEARCH catalog_mirror USING INDEX sqlite_autoindex_catalog_mirror_1/);
  assert.doesNotMatch(plan,/SCAN catalog_mirror(?:\s|$)/);
});

test('empty retry queue excludes completed history; pending priority and retry backoff remain unchanged',t => {
  const db = new LocalD1(false); t.after(() => db.sqlite.close());
  const insert = db.sqlite.prepare("INSERT INTO submissions(id,type,original_json,revision_json,receipt_hash,status,created_at,updated_at,schema_version,entity_type,live_published_at,live_attempt_at) VALUES(?,'new','{}','{}',?,'exporting',?,?,2,?,?,?)");
  db.sqlite.exec('BEGIN');
  for(let i=0;i<1000;i++)insert.run('history-'+i,'history-'+i,'2026-10-01','2026-10-01','venue','2026-10-01',null);
  db.sqlite.exec('COMMIT');
  const threshold = '2026-10-04T00:00:00Z';
  const before = db.sqlite.prepare('EXPLAIN QUERY PLAN '+LIVE_RESUME_SQL.replace(' INDEXED BY idx_submissions_live_resume','')).all(threshold).map(row=>row.detail).join('\n');
  assert.match(before,/idx_submissions_status_created/); assert.match(before,/USE TEMP B-TREE/);
  db.sqlite.exec(queryMigration);
  const after = db.sqlite.prepare('EXPLAIN QUERY PLAN '+LIVE_RESUME_SQL).all(threshold).map(row=>row.detail).join('\n');
  assert.match(after,/idx_submissions_live_resume/); assert.doesNotMatch(after,/USE TEMP B-TREE/);
  assert.deepEqual(db.sqlite.prepare(LIVE_RESUME_SQL).all(threshold),[]);
  assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM submissions INDEXED BY idx_submissions_live_resume WHERE schema_version=2 AND status IN ('exporting','export_failed','merged_dev','merged_main') AND live_published_at IS NULL").get().n,0);
  for(const [id,type,date,attempt] of [['food','food','2026-10-01',null],['venue','venue','2026-10-03',null],['review','review','2026-10-01',null],['backoff','venue','2026-10-01','2026-10-04T01:00:00Z']])insert.run(id,id,date,date,type,null,attempt);
  assert.deepEqual(db.sqlite.prepare(LIVE_RESUME_SQL).all(threshold).map(row=>row.id),['venue','food','review']);
});
