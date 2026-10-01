import { Hono } from 'hono';
import { readLive } from '../live-catalog.js';
import { publicCatalog } from '../../lib/catalog/visibility.js';
import { discoveryCatalog } from '../../lib/catalog/discovery.js';
import { liveContent } from '../config.js';
import type { AppEnv } from '../types.js';

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
  const {state,catalog}=await readLive(c.env.DB);
  return c.json({...discoveryCatalog(catalog),revision:state.revision,snapshotId:'current'});
});
livePublicRoutes.get('/:type/:id',async c=>{
  const type=c.req.param('type');
  if(type!=='food'&&type!=='venue')return c.notFound();
  const {catalog,state}=await readLive(c.env.DB),visible=publicCatalog(catalog);
  const record=(type==='food'?visible.foods:visible.restaurants).find(r=>r.id===c.req.param('id'));
  if(!record)return c.json({error:{message:'内容不存在或已下架'}},404);
  return c.json({type,record,revision:state.revision,reviews:visible.reviews.filter(r=>r.targetType===type&&r.targetId===record.id),venue:type==='food'?visible.restaurants.find(v=>v.id===('venueId' in record?record.venueId:'')):null,foods:type==='venue'?visible.foods.filter(f=>f.venueId===record.id):[]});
});
