import { Hono } from 'hono';
import { publicationEnabled } from '../config.js';
import { readLimitedBody } from '../media.js';
import { sha256 } from './submissions.js';
import { parseManaged, validateManagedEdit, validateManagedRelations, type ManagedType } from '../../lib/catalog/management.js';
import type { AppEnv } from '../types.js';

export const contentAdminRoutes = new Hono<AppEnv>();
const types = ['food','venue','review'];
contentAdminRoutes.get('/', async context => {
  if (!publicationEnabled(context.env)) return context.json({ error: { message: '内容管理暂不可用。' } },503);
  const rows = await context.env.DB.prepare('SELECT entity_type, entity_id, payload_json, content_hash FROM catalog_mirror ORDER BY entity_type, entity_id').all<{entity_type: ManagedType; entity_id:string; payload_json:string; content_hash:string}>();
  const active = await context.env.DB.prepare("SELECT id, entity_id, status FROM submissions WHERE entity_type = 'management' AND status NOT IN ('deployed','rejected')").all();
  return context.json({ entries: rows.results.map(row=>({type:row.entity_type,record:JSON.parse(row.payload_json),hash:row.content_hash})), active:active.results },200,{'Cache-Control':'no-store'});
});

contentAdminRoutes.post('/:type/:id', async context => {
  if (!publicationEnabled(context.env)) return context.json({error:{message:'内容管理暂不可用。'}},503);
  const origin=context.req.header('Origin');
  if(origin && origin!==new URL(context.req.url).origin)return context.json({error:{message:'请求来源不允许。'}},403);
  const type=context.req.param('type') as ManagedType, entityId=context.req.param('id');
  if(!types.includes(type))return context.json({error:{message:'内容类型无效。'}},400);
  const body=await readLimitedBody(context.req.raw,128*1024);
  let input:{expectedHash?:unknown;record?:unknown;reason?:unknown};
  try { input=JSON.parse(new TextDecoder().decode(body.bytes!)); } catch { return context.json({error:{message:'编辑内容无效或过大。'}},422); }
  if(!input || typeof input.expectedHash!=='string' || typeof input.reason!=='string' || !input.reason.trim() || input.reason.length>500)return context.json({error:{message:'请填写修改原因并保留版本号。'}},422);
  const rows=await context.env.DB.prepare('SELECT entity_type, entity_id, payload_json, content_hash, snapshot_id FROM catalog_mirror').all<{entity_type:ManagedType;entity_id:string;payload_json:string;content_hash:string;snapshot_id:string}>();
  const current=rows.results.find(row=>row.entity_type===type&&row.entity_id===entityId);
  if(!current || current.content_hash!==input.expectedHash)return context.json({error:{message:'线上版本已变化，请刷新后重新编辑。'}},409);
  let record;
  try{
    const before=parseManaged(type,JSON.parse(current.payload_json));
    record=validateManagedEdit(type,before,input.record);
    validateManagedRelations(type,record,rows.results.map(row=>({type:row.entity_type,record:parseManaged(row.entity_type,JSON.parse(row.payload_json))})));
  }catch(error){return context.json({error:{code:error instanceof Error?error.message:'invalid_edit',message:'修改未通过检查：请检查字段、封面授权及店铺关联；有在售餐品或子档口的店铺不能直接下架。'}},422);}
  const id=crypto.randomUUID(),jobId=crypto.randomUUID(),now=new Date().toISOString();
  const revision=JSON.stringify({operation:'catalog-edit',entityType:type,expectedHash:current.content_hash,record});
  const hash=await sha256(revision);
  try{
    const results=await context.env.DB.batch([
      context.env.DB.prepare("INSERT INTO submissions (id,type,original_json,revision_json,receipt_hash,status,version,created_at,updated_at,reviewed_at,reviewer,schema_version,entity_type,entity_id,upload_state,snapshot_id) SELECT ?, 'correction', ?, ?, ?, 'exporting', 1, ?, ?, ?, ?, 2, 'management', ?, 'pending', ? FROM catalog_mirror WHERE entity_type=? AND entity_id=? AND content_hash=?")
        .bind(id,current.payload_json,revision,await sha256(crypto.randomUUID()),now,now,now,context.get('reviewer'),`${type}:${entityId}`,current.snapshot_id,type,entityId,current.content_hash),
      context.env.DB.prepare("INSERT INTO audit_events (id,submission_id,reviewer,action,version,reason,created_at) SELECT ?,id,?,'edit',1,?,? FROM submissions WHERE id=?").bind(crypto.randomUUID(),context.get('reviewer'),input.reason.trim(),now,id),
      context.env.DB.prepare("INSERT INTO publication_jobs (id,submission_id,submission_version,content_hash,status,branch,attempts,created_at,updated_at) SELECT ?,id,1,?,'queued',?,0,?,? FROM submissions WHERE id=?").bind(jobId,hash,`submission/${id}`,now,now,id),
    ]);
    if(results.some(result=>!result.meta.changes))return context.json({error:{message:'内容版本已变化，请刷新。'}},409);
  }catch{return context.json({error:{message:'该内容可能已有待发布修改，请先处理发布记录后重试。'}},409);}
  return context.json({submissionId:id,publicationJobId:jobId,status:'queued'},202,{'Cache-Control':'no-store'});
});
