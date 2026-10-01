import { Hono } from 'hono';
import { readLive } from '../live-catalog.js';
import { liveContent } from '../config.js';
import { sha256 } from './submissions.js';
import type { AppEnv } from '../types.js';

export const backupRoutes=new Hono<AppEnv>();
backupRoutes.use('/*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  if(!liveContent(c.env)||!c.env.DEPLOY_WEBHOOK_SECRET)return c.json({error:'unavailable'},503);
  const stamp=c.req.header('X-Backup-Timestamp')??'',signature=c.req.header('X-Backup-Signature')??'';
  if(!/^\d{13}$/.test(stamp)||Math.abs(Date.now()-Number(stamp))>300000||!/^[a-f0-9]{64}$/.test(signature))return c.json({error:'unauthorized'},401);
  const body=await c.req.text();if(body.length>4096)return c.json({error:'too_large'},413);
  const key=await crypto.subtle.importKey('raw',new TextEncoder().encode(c.env.DEPLOY_WEBHOOK_SECRET),{name:'HMAC',hash:'SHA-256'},false,['verify']);
  const bytes=Uint8Array.from(signature.match(/../g)!,b=>parseInt(b,16));
  const message=`backup-v1\n${stamp}\n${c.req.method}\n${new URL(c.req.url).pathname}\n${body}`;
  if(!await crypto.subtle.verify('HMAC',key,bytes,new TextEncoder().encode(message)))return c.json({error:'unauthorized'},401);
  await next();
});
backupRoutes.get('/export',async c=>{
  const {state,catalog}=await readLive(c.env.DB);
  // Only canonical previously published content, including recoverable archives.
  // Never SELECT submission payloads, audit notes, tokens or R2 object keys.
  const snapshot={schemaVersion:1,revision:state.revision,catalog};
  const content=JSON.stringify(snapshot),hash=await sha256(content);
  await c.env.DB.prepare('INSERT INTO backup_exports(revision,content_hash,created_at) VALUES(?,?,?) ON CONFLICT(revision) DO NOTHING').bind(state.revision,hash,new Date().toISOString()).run();
  return c.json({snapshot,contentHash:hash});
});
backupRoutes.post('/ack',async c=>{
  const body=await c.req.json().catch(()=>null);
  if(!body||!Number.isSafeInteger(body.revision)||typeof body.contentHash!=='string'||! /^[a-f0-9]{40,64}$/.test(body.commit??''))return c.json({error:'invalid_ack'},422);
  const result=await c.env.DB.prepare('UPDATE live_catalog_state SET backed_revision=?,backup_commit=?,backed_at=? WHERE id=1 AND revision>=? AND backed_revision<=? AND EXISTS(SELECT 1 FROM backup_exports WHERE revision=? AND content_hash=?)').bind(body.revision,body.commit,new Date().toISOString(),body.revision,body.revision,body.revision,body.contentHash).run();
  return c.json({acknowledged:Boolean(result.meta.changes)});
});
