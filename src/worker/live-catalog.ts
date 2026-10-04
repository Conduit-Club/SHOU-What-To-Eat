import { LEGACY_FOOD_IDS } from '../lib/legacy-foods';
import { tagLabel } from '../utils/catalog-display';
import { type Catalog, type Food, type Venue, type Review, deriveDistanceTags } from '../lib/catalog/index.js';
import { parseManaged, validateManagedEdit, validateManagedRelations, type ManagedType, type ManagedRecord } from '../lib/catalog/management.js';
import { canonicalVenue, canonicalFood, canonicalReview, imageRecord } from './publication/github.js';
import { validateV2Revision } from './v2-validation.js';
import { sha256 } from './routes/submissions.js';
import type { AppEnv } from './types.js';
import type { AuthSession } from './auth.js';
import { submissionSessionAssertion } from './submission-auth.js';
import { publicAvatar } from '../utils/review-identity.js';

export type LiveEntry = { type: ManagedType; record: ManagedRecord; hash: string; snapshotId: string };
export type LiveState = { revision: number; backed_revision: number; backup_commit: string | null; backed_at: string | null; updated_at: string };
export async function readLive(db: D1Database) {
  // One D1 batch gives the revision and its records a consistent snapshot.
  const result = await db.batch([
    db.prepare('SELECT * FROM live_catalog_state WHERE id=1'),
    db.prepare('SELECT entity_type,entity_id,payload_json,content_hash,snapshot_id FROM catalog_mirror ORDER BY entity_type,entity_id'),
  ]);
  const state = result[0].results[0] as unknown as LiveState;
  if (!state) throw new Error('catalog_unavailable');
  const entries: LiveEntry[] = result[1].results.map((r: any) => ({ type:r.entity_type,record:parseManaged(r.entity_type,JSON.parse(r.payload_json)),hash:r.content_hash,snapshotId:r.snapshot_id }));
  const catalog: Catalog = { schemaVersion:2, restaurants:entries.filter(e=>e.type==='venue').map(e=>e.record as Venue),foods:entries.filter(e=>e.type==='food').map(e=>e.record as Food),reviews:entries.filter(e=>e.type==='review').map(e=>e.record as Review) };
  return {state,entries,catalog};
}

function assertion(db: D1Database) { return db.prepare('INSERT INTO live_write_assertion(ok) VALUES(CASE WHEN changes()=1 THEN 1 ELSE 0 END)'); }
export function beginLiveWrite(db: D1Database, revision: number, now: string) {
  return [db.prepare('UPDATE live_catalog_state SET revision=revision+1,updated_at=? WHERE id=1 AND revision=?').bind(now,revision),assertion(db)];
}
async function recordWrites(db:D1Database, entries:LiveEntry[], revision:number, now:string) {
  const statements:D1PreparedStatement[]=[];
  for(const entry of entries){
    const record=entry.record, json=JSON.stringify(record),hash=await sha256(json);
    statements.push(db.prepare('INSERT INTO catalog_mirror(entity_type,entity_id,snapshot_id,payload_json,content_hash,synced_at) VALUES(?,?,?,?,?,?) ON CONFLICT(entity_type,entity_id) DO UPDATE SET payload_json=excluded.payload_json,content_hash=excluded.content_hash,synced_at=excluded.synced_at').bind(entry.type,record.id,entry.snapshotId,json,hash,now));
    statements.push(db.prepare('INSERT INTO catalog_history(revision,entity_type,entity_id,payload_json,created_at) VALUES(?,?,?,?,?)').bind(revision,entry.type,record.id,json,now));
    if('tags' in record){
      statements.push(db.prepare('DELETE FROM entity_tags WHERE entity_type=? AND entity_id=?').bind(entry.type,record.id));
      for(const raw of record.tags){
        const label=tagLabel(raw),key=label.toLowerCase(),id=`tag-${(await sha256(key)).slice(0,32)}`;
        statements.push(db.prepare('INSERT INTO tags(id,tag_key,label,created_at) VALUES(?,?,?,?) ON CONFLICT(tag_key) DO UPDATE SET label=excluded.label').bind(id,key,label,now));
        statements.push(db.prepare('INSERT INTO entity_tags(entity_type,entity_id,tag_id) SELECT ?,?,id FROM tags WHERE tag_key=? ON CONFLICT DO NOTHING').bind(entry.type,record.id,key));
      }
    }
    const state=record.status==='archived'?'archived':'published';
    const table=entry.type==='venue'?'venues':entry.type==='food'?'foods':'reviews';
    statements.push(db.prepare(`UPDATE ${table} SET publication_state=?,content_hash=?,updated_at=?,published_at=COALESCE(published_at,?) WHERE id=?`).bind(state,hash,now,now,record.id),assertion(db));
    if(entry.type==='venue'){
      const v=record as Venue,p=v.averagePrice;
      statements.push(db.prepare('UPDATE venues SET name=?,parent_id=?,type=?,campus_scope=?,address=?,campus=?,floor=?,landmark=?,distance_m=?,distance_basis=?,average_price_min=?,average_price_max=?,average_price_source=? WHERE id=?').bind(v.name,v.parentId,v.kind,v.category,v.location.address,v.location.campusArea,v.location.floor,v.location.landmark,v.location.distanceMeters,v.location.distanceBasis,p?.minCents??null,p?.maxCents??null,p?.source??null,v.id));
    } else if(entry.type==='food'){
      const f=record as Food,p=f.price;
      statements.push(db.prepare('UPDATE foods SET name=?,venue_id=?,meal_types_json=?,meal_type=?,description=?,price=?,price_min=?,price_max=?,price_source=? WHERE id=?').bind(f.name,f.venueId,JSON.stringify(f.mealTypes),f.mealTypes[0]??null,f.description,p?.amountCents??null,p?.minCents??null,p?.maxCents??null,p?.source??null,f.id));
      statements.push(db.prepare('DELETE FROM food_meal_types WHERE food_id=?').bind(f.id));
      for(const [ordinal,meal] of f.mealTypes.entries())statements.push(db.prepare('INSERT INTO food_meal_types(food_id,meal_type,ordinal) VALUES(?,?,?)').bind(f.id,meal,ordinal));
    } else {const r=record as Review;statements.push(db.prepare('UPDATE reviews SET rating=?,text=? WHERE id=?').bind(r.rating,r.text,r.id));}
  }
  return statements;
}
function changedParents(entries:LiveEntry[],food:Food,oldParent?:string):LiveEntry[]{
  return entries.filter(e=>e.type==='venue'&&(e.record.id===food.venueId||e.record.id===oldParent)).map(e=>{
    const venue=e.record as Venue;
    return {...e,record:{...venue,foods:[...new Set([...venue.foods.filter(id=>id!==food.id),...(venue.id===food.venueId?[food.id]:[])])]}};
  });
}

export async function editLive(env:AppEnv['Bindings'],type:ManagedType,id:string,input:{expectedHash:string;record:unknown;reason:string},reviewer:string,legacy?:{id:string;version:number}){
  const {state,entries}=await readLive(env.DB),current=entries.find(e=>e.type===type&&e.record.id===id);
  if(!current||current.hash!==input.expectedHash)throw new Error('revision_conflict');
  let record=validateManagedEdit(type,current.record,input.record);
  validateManagedRelations(type,record,entries);
  const now=new Date().toISOString();
  if(type!=='review'){record={...record,dates:{...(record as Food|Venue).dates,updatedAt:now.slice(0,10)}} as ManagedRecord;}
  if(type==='venue')record={...record,tags:deriveDistanceTags(record as Venue)} as Venue;
  const changed=[{...current,record},...(type==='food'?changedParents(entries,record as Food,(current.record as Food).venueId):[])];
  const submissionId=legacy?.id??crypto.randomUUID();
  const statements=beginLiveWrite(env.DB,state.revision,now);
  if(legacy){statements.push(env.DB.prepare("UPDATE submissions SET status='deployed',live_published_at=?,live_error=NULL,updated_at=?,version=version+1 WHERE id=? AND version=? AND live_published_at IS NULL AND status IN ('exporting','export_failed','merged_dev','merged_main')").bind(now,now,legacy.id,legacy.version),assertion(env.DB));}
  else statements.push(env.DB.prepare("INSERT INTO submissions(id,type,original_json,revision_json,receipt_hash,status,version,created_at,updated_at,reviewed_at,reviewer,schema_version,entity_type,entity_id,upload_state,snapshot_id,live_published_at) VALUES(?,'correction',?,?,?,'deployed',1,?,?,?,?,2,'management',?,'pending',?,?)").bind(submissionId,JSON.stringify(current.record),JSON.stringify({operation:'catalog-edit',entityType:type,record}),await sha256(crypto.randomUUID()),now,now,now,reviewer,`${type}:${id}`,current.snapshotId,now));
  statements.push(...await recordWrites(env.DB,changed,state.revision+1,now));
  statements.push(env.DB.prepare("INSERT INTO audit_events(id,submission_id,reviewer,action,version,reason,created_at) VALUES(?,?,?,'edit',1,?,?)").bind(crypto.randomUUID(),submissionId,reviewer,input.reason,now));
  statements.push(env.DB.prepare('DELETE FROM live_write_assertion'));
  await env.DB.batch(statements);
  return {submissionId,status:'published',revision:state.revision+1,backupStatus:'pending'};
}

export async function publishLive(env:AppEnv['Bindings'],id:string,expectedVersion:number,reviewer:string,legacy=false,directActor?:AuthSession){
  const {state,entries}=await readLive(env.DB);
  const row=await env.DB.prepare('SELECT * FROM submissions WHERE id=? AND schema_version=2').bind(id).first<any>();
  if(!row||row.version!==expectedVersion||row.live_published_at||!(legacy?['exporting','export_failed','merged_dev','merged_main']:['pending']).includes(row.status))throw new Error('revision_conflict');
  if(directActor&&(legacy||row.publication_mode!=='direct'||row.submitter_user_id!==directActor.userId||!['food','review'].includes(row.entity_type)))throw new Error('submission_owner_required');
  if(row.entity_type==='management'){
    if(!legacy)throw new Error('revision_conflict');
    const draft=JSON.parse(row.revision_json);
    return editLive(env,draft.entityType,draft.record.id,{expectedHash:draft.expectedHash,record:draft.record,reason:'接续已审核的旧版内容修改'},reviewer,{id,version:expectedVersion});
  }
  const revision=validateV2Revision(JSON.parse(row.revision_json),{entityType:row.entity_type,snapshotId:row.snapshot_id,expectedImages:row.expected_images,expectedReviewImages:row.expected_review_images});
  const assets=(await env.DB.prepare("SELECT * FROM media_assets WHERE submission_id=? AND object_state IN ('private','published') ORDER BY slot,slot_index").bind(id).all<any>()).results;
  if(row.upload_state!=='pending'||assets.filter(a=>a.slot==='entity').length!==row.expected_images||assets.filter(a=>a.slot==='attachedReview').length!==row.expected_review_images||assets.some(a=>a.rights_confirmed!==1))throw new Error('images_incomplete');
  // R2 bytes are immutable and private. Public delivery is gated by D1, so
  // publication needs no R2 rewrite and cannot expose half-committed content.
  for(const asset of assets){if(!env.IMAGES||!await env.IMAGES.head(asset.object_key))throw new Error('media_object_missing');}
  const images=(slot:string)=>assets.filter(a=>a.slot===slot).map(a=>imageRecord({...a,permission:'approved'}));
  const source=Array.isArray(revision.payload.sources)&&revision.payload.sources.length?revision.payload.sources:[{repository:'shou-food-contributions',path:`submissions/${id}`,revision:await sha256(row.revision_json),license:null,note:directActor?'登录用户直接投稿':'审核通过的投稿',sourceUrl:null,collectedAt:null}];
  const authenticated = row.submitter_user_id !== null && row.submitter_user_id !== undefined;
  const publicIdentity = row.public_identity_recorded === 1 || authenticated
    ? { authorAlias: row.public_author_alias, authorAvatar: row.public_author_alias ? publicAvatar(row.public_author_avatar) : null } : {};
  const p=row.entity_type==='review'?{...revision.payload,...publicIdentity}:revision.payload,now=new Date().toISOString(),type=row.entity_type as ManagedType;
  const record=parseManaged(type,type==='venue'?canonicalVenue(p,row.entity_id,images('entity'),source,now):type==='food'?canonicalFood(p,row.entity_id,row.parent_entity_id,images('entity'),source,now):canonicalReview(p,row.entity_id,images('entity'),source));
  if(entries.some(e=>e.type===type&&e.record.id===record.id))throw new Error('entity_already_published');
  validateManagedRelations(type,record,entries);
  if(type==='review'){
    const r=record as Review,target=entries.find(e=>e.type===r.targetType&&e.record.id===r.targetId);
    if(!target||target.record.status==='archived')throw new Error('review_target_unavailable');
  }
  const changed:LiveEntry[]=[{type,record,hash:'',snapshotId:row.snapshot_id},...(type==='food'?changedParents(entries,record as Food):[])];
  if(revision.attachedReview){
    if(!row.attached_review_id)throw new Error('attached_review_missing');
    changed.push({type:'review',record:parseManaged('review',canonicalReview({...revision.attachedReview,targetType:type,targetId:record.id,...publicIdentity},row.attached_review_id,images('attachedReview'),source)),hash:'',snapshotId:row.snapshot_id});
  }
  const statements=beginLiveWrite(env.DB,state.revision,now);
  if(directActor){
    statements.push(submissionSessionAssertion(env,directActor));
    statements.push(env.DB.prepare("INSERT INTO live_write_assertion(ok) VALUES(CASE WHEN EXISTS (SELECT 1 FROM submissions WHERE id=? AND submitter_user_id=? AND publication_mode='direct' AND entity_type IN ('food','review') AND upload_state='pending') THEN 1 ELSE 0 END)").bind(id,directActor.userId));
  }
  // A parent/target must still be public at the transactional publication point.
  if(type==='food')statements.push(env.DB.prepare("INSERT INTO live_write_assertion(ok) VALUES(CASE WHEN EXISTS (SELECT 1 FROM venues WHERE id=? AND publication_state='published') THEN 1 ELSE 0 END)").bind(row.parent_entity_id));
  if(type==='review')statements.push(env.DB.prepare(`INSERT INTO live_write_assertion(ok) VALUES(CASE WHEN EXISTS (SELECT 1 FROM ${(record as Review).targetType==='food'?'foods':'venues'} WHERE id=? AND publication_state='published') THEN 1 ELSE 0 END)`).bind((record as Review).targetId));
  statements.push(env.DB.prepare("UPDATE submissions SET status='deployed',version=version+1,reviewer=?,reviewed_at=COALESCE(reviewed_at,?),updated_at=?,live_published_at=?,live_error=NULL WHERE id=? AND version=? AND status=? AND live_published_at IS NULL").bind(reviewer,now,now,now,id,expectedVersion,row.status),assertion(env.DB));
  statements.push(...await recordWrites(env.DB,changed,state.revision+1,now));
  statements.push(env.DB.prepare("UPDATE media_assets SET object_state='published',permission='approved',published_at=? WHERE submission_id=? AND rights_confirmed=1").bind(now,id));
  statements.push(env.DB.prepare("INSERT INTO audit_events(id,submission_id,reviewer,action,version,reason,created_at) VALUES(?,?,?,'publish',?,?,?)").bind(crypto.randomUUID(),id,reviewer,expectedVersion+1,directActor?'authenticated_direct':legacy?'live_cutover':'live_approval',now));
  statements.push(env.DB.prepare('DELETE FROM live_write_assertion'));
  await env.DB.batch(statements);
  return {submissionId:id,status:'published',revision:state.revision+1,backupStatus:'pending'};
}

export async function resumeApproved(env:AppEnv['Bindings']){
  const rows=(await env.DB.prepare("SELECT id,version,reviewer,entity_type FROM submissions WHERE schema_version=2 AND status IN ('exporting','export_failed','merged_dev','merged_main') AND live_published_at IS NULL AND (live_attempt_at IS NULL OR live_attempt_at<?) ORDER BY CASE entity_type WHEN 'venue' THEN 0 WHEN 'food' THEN 1 ELSE 2 END,created_at LIMIT 10").bind(new Date(Date.now()-300000).toISOString()).all<any>()).results;
  for(const row of rows){
    try{await publishLive(env,row.id,row.version,row.reviewer||'migration',true);}
    catch(error){
      const code=error instanceof Error&&/^[a-z_]+$/.test(error.message)?error.message:'live_cutover_conflict';
      await env.DB.prepare('UPDATE submissions SET live_error=?,live_attempt_at=? WHERE id=? AND live_published_at IS NULL').bind(code,new Date().toISOString(),row.id).run();
    }
  }
}

/** Resumable small batches: preserve all provenance and audit every changed record. */
export async function maintainLegacyCatalog(env:AppEnv['Bindings'],reviewer:string) {
 const {state,entries}=await readLive(env.DB);
 const candidates=entries.flatMap(entry=>{
  const original=entry.record;
  const legacy=entry.type==='food'?LEGACY_FOOD_IDS.has(original.id):entry.type==='review'&&(original as Review).targetType==='food'&&LEGACY_FOOD_IDS.has((original as Review).targetId);
  const record=structuredClone(original);
  if(legacy)record.status='archived';
  if('tags' in record)record.tags=[...new Set(record.tags.map(tagLabel))];
  if(JSON.stringify(record)===JSON.stringify(original))return [];
  return [{...entry,record}];
 });
 const changed=candidates.slice(0,5);
 if(!changed.length)return {changed:0,remaining:0,revision:state.revision};
 const now=new Date().toISOString(),statements=beginLiveWrite(env.DB,state.revision,now);
 for(const entry of changed){
  const previous=entries.find(e=>e.type===entry.type&&e.record.id===entry.record.id)!;
  validateManagedEdit(entry.type,previous.record,entry.record);
  // Existing cover references remain in history; archived content is never exposed.
  const id=crypto.randomUUID();
  statements.push(env.DB.prepare("INSERT INTO submissions(id,type,original_json,revision_json,receipt_hash,status,version,created_at,updated_at,reviewed_at,reviewer,schema_version,entity_type,entity_id,upload_state,snapshot_id,live_published_at) VALUES(?,'correction',?,?,?,'deployed',1,?,?,?,?,2,'management',?,'pending',?,?)").bind(id,JSON.stringify(previous.record),JSON.stringify({operation:'catalog-edit',entityType:entry.type,record:entry.record}),await sha256(crypto.randomUUID()),now,now,now,reviewer,`${entry.type}:${entry.record.id}`,entry.snapshotId,now));
  statements.push(env.DB.prepare("INSERT INTO audit_events(id,submission_id,reviewer,action,version,reason,created_at) VALUES(?,?,?,'edit',1,?,?)").bind(crypto.randomUUID(),id,reviewer,'按站点所有者要求下架旧资料餐品及关联评价，保留原文与来源；标签转为中文。',now));
 }
 statements.push(...await recordWrites(env.DB,changed,state.revision+1,now),env.DB.prepare('DELETE FROM live_write_assertion'));
 await env.DB.batch(statements);
 return {changed:changed.length,remaining:candidates.length-changed.length,revision:state.revision+1};
}
