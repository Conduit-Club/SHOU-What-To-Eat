import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { submissionRoutes } from './routes/submissions.js';
import { submissionV2Routes } from './routes/submissions-v2.js';
import { adminRoutes } from './routes/admin.js';
import { adminV2Routes } from './routes/admin-v2.js';
import { webhookRoutes } from './routes/webhooks.js';
import { publicMediaResponse } from './media.js';
import { missingDeploymentConfig, publicationEnabled, liveContent } from './config.js';
import { livePublicRoutes } from './routes/live-public.js';
import { backupRoutes } from './routes/backup.js';
import { liveDetail } from './live-detail.js';
import { resumeApproved } from './live-catalog.js';
import type { AppEnv } from './types.js';
import { isDatabaseError } from './errors.js';
import { authRoutes } from './routes/auth.js';

const app = new Hono<AppEnv>();
 app.use('/api/*', cors({ origin: (origin, context) => (context.env.ALLOWED_ORIGINS ?? '').split(',').map((item: string) => item.trim()).includes(origin) ? origin : null, allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'Cf-Access-Jwt-Assertion', 'Idempotency-Key', 'X-Submission-Version', 'X-Image-Slot', 'X-Image-Index', 'X-Image-Alt', 'X-Image-Source', 'X-Image-Source-Note', 'X-Image-Copyright-Holder', 'X-Image-License', 'X-Image-Permission', 'X-Image-Rights-Confirmed', 'X-Image-Is-Illustrative', 'X-Image-Metadata-Encoding', 'X-Image-Cover-Allowed'] }));
const health = (context: Context<AppEnv>) => {
  const enabled = publicationEnabled(context.env);
  const ready = !enabled || missingDeploymentConfig(context.env).length === 0;
  return context.json({ status: ready ? 'ok' : 'unavailable', mode: enabled ? 'full' : 'catalog-only' }, ready ? 200 : 503, { 'Cache-Control': 'no-store' });
};
app.get('/api/health', health);
app.get('/api/v1/health', health);
app.route('/auth', authRoutes);
app.route('/api/v1/submissions', submissionRoutes);
app.route('/api/v2/submissions', submissionV2Routes);
app.route('/api/v2/public', livePublicRoutes);
app.route('/api/v2/backup', backupRoutes);
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v2/admin', adminV2Routes);
// The existing /admin paths remain protected at the Cloudflare Access edge.
// Unified Auth management uses distinct paths with identical Worker checks.
app.route('/api/manage/v1', adminRoutes);
app.route('/api/manage/v2', adminV2Routes);
app.route('/api/v1/webhooks', webhookRoutes);
app.get('/media/:assetId', async (context) => publicMediaResponse(context.req.raw, context.env, context.req.param('assetId')));
app.notFound((context) => context.json({ error: { code: 'not_found', message: '没有找到该 API。' } }, 404, { 'Cache-Control': 'no-store' }));
app.onError((error, context) => isDatabaseError(error)
  ? context.json({ error: { code: 'database_error', message: '数据库错误，请稍后重试。' } }, 503, { 'Cache-Control': 'no-store' })
  : context.json({ error: { code: 'internal_error', message: '请求暂时无法处理。' } }, 500, { 'Cache-Control': 'no-store' }));

export default {
  async fetch(request: Request, env: AppEnv['Bindings'], executionContext: ExecutionContext) {
    const url = new URL(request.url);
    if(liveContent(env)){
      if(url.pathname==='/catalog-index.json')return app.fetch(new Request(new URL('/api/v2/public/catalog',url),request),env,executionContext);
      if(url.pathname==='/catalog-snapshot.json')return Response.json({schemaVersion:2,snapshotId:'current'},{headers:{'Cache-Control':'no-store'}});
      let path=url.pathname;try{path=decodeURIComponent(path);}catch{return new Response('Not found',{status:404});}
      const detail=path.replace(/\/index\.html$/,'/').match(/^\/(foods|restaurants)\/([a-z0-9]+(?:-[a-z0-9]+)*)\/?$/);
      if(detail){try{return await liveDetail(request,env,detail[1]==='foods'?'food':'venue',detail[2]);}catch(error){return new Response(isDatabaseError(error)?'数据库错误，请稍后重试。':'资料暂时无法加载，请稍后刷新。',{status:503,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});}}
      if(/^\/(foods|restaurants)\/.+/.test(path)&&!/^\/(foods|restaurants)\/index\.html$/.test(path))return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
    }
    if (url.pathname === '/auth' || url.pathname.startsWith('/auth/') || url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return app.fetch(request, env, executionContext);
    if (!env.ASSETS) return new Response('Static assets are not configured.\n', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: ScheduledController, env: AppEnv['Bindings'], executionContext: ExecutionContext) {
    if (!publicationEnabled(env)) return;
    if (missingDeploymentConfig(env).length) return;
    if(liveContent(env)){executionContext.waitUntil(resumeApproved(env));return;}
    const { processPublicationQueue } = await import('./publication/queue.js');
    executionContext.waitUntil(processPublicationQueue(env));
  },
};
