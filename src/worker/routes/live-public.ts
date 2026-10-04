import { Hono } from 'hono';
import { readLive } from '../live-catalog.js';
import { readPublicDetail } from '../public-detail.js';
import { discoveryCatalog } from '../../lib/catalog/discovery.js';
import { liveContent } from '../config.js';
import type { AppEnv } from '../types.js';
import { ifNoneMatchMatches } from '../etag.js';

export const livePublicRoutes=new Hono<AppEnv>();
livePublicRoutes.use('/*',async(c,next)=>{
  c.header('Cache-Control','no-store');
  if(!liveContent(c.env))return c.json({error:{message:'动态目录未启用'}},503);
  await next();
});
livePublicRoutes.get('/version',async c=>{
  const state=await c.env.DB.prepare('SELECT revision,updated_at FROM live_catalog_state WHERE id=1').first();
  return c.json(state);
});
livePublicRoutes.get('/catalog',async c=>{
  const tag=(revision:number)=>`"eat-catalog-v1-${revision}"`;
  const requested=c.req.header('If-None-Match');
  if(requested){
    const current=await c.env.DB.prepare('SELECT revision FROM live_catalog_state WHERE id=1').first<{revision:number}>();
    if(current&&ifNoneMatchMatches(requested,tag(current.revision))){c.header('ETag',tag(current.revision));return c.body(null,304);}
  }
  const {state,catalog}=await readLive(c.env.DB);
  c.header('ETag',tag(state.revision));
  return c.json({...discoveryCatalog(catalog),revision:state.revision,snapshotId:'current'});
});
livePublicRoutes.get('/:type/:id',async c=>{
  const type=c.req.param('type');
  if(type!=='food'&&type!=='venue')return c.notFound();
  const {record,state,reviews,venue,foods}=await readPublicDetail(c.env.DB,type,c.req.param('id'));
  if(!record)return c.json({error:{message:'内容不存在或已下架'}},404);
  return c.json({type,record,revision:state.revision,reviews,venue,foods});
});
