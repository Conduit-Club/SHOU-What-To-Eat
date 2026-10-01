import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { submissionRoutes } from './routes/submissions.js';
import { submissionV2Routes } from './routes/submissions-v2.js';
import { adminRoutes } from './routes/admin.js';
import { adminV2Routes } from './routes/admin-v2.js';
import { webhookRoutes } from './routes/webhooks.js';
import { publicMediaResponse } from './media.js';
import { missingDeploymentConfig, publicationEnabled } from './config.js';
import type { AppEnv } from './types.js';

const app = new Hono<AppEnv>();
 app.use('/api/*', cors({ origin: (origin, context) => (context.env.ALLOWED_ORIGINS ?? '').split(',').map((item: string) => item.trim()).includes(origin) ? origin : null, allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'Cf-Access-Jwt-Assertion', 'Idempotency-Key', 'X-Submission-Version', 'X-Image-Slot', 'X-Image-Index', 'X-Image-Alt', 'X-Image-Source', 'X-Image-Source-Note', 'X-Image-Copyright-Holder', 'X-Image-License', 'X-Image-Permission', 'X-Image-Rights-Confirmed', 'X-Image-Is-Illustrative', 'X-Image-Metadata-Encoding', 'X-Image-Cover-Allowed'] }));
const health = (context: Context<AppEnv>) => {
  const enabled = publicationEnabled(context.env);
  const ready = !enabled || missingDeploymentConfig(context.env).length === 0;
  return context.json({ status: ready ? 'ok' : 'unavailable', mode: enabled ? 'full' : 'catalog-only' }, ready ? 200 : 503, { 'Cache-Control': 'no-store' });
};
app.get('/api/health', health);
app.get('/api/v1/health', health);
app.route('/api/v1/submissions', submissionRoutes);
app.route('/api/v2/submissions', submissionV2Routes);
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v2/admin', adminV2Routes);
app.route('/api/v1/webhooks', webhookRoutes);
app.get('/media/:assetId', async (context) => publicMediaResponse(context.req.raw, context.env, context.req.param('assetId')));
app.notFound((context) => context.json({ error: { code: 'not_found', message: '没有找到该 API。' } }, 404, { 'Cache-Control': 'no-store' }));
app.onError((_error, context) => context.json({ error: { code: 'internal_error', message: '请求暂时无法处理。' } }, 500, { 'Cache-Control': 'no-store' }));

export default {
  fetch(request: Request, env: AppEnv['Bindings'], executionContext: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/media/')) return app.fetch(request, env, executionContext);
    if (!env.ASSETS) return new Response('Static assets are not configured.\n', { status: 503, headers: { 'Cache-Control': 'no-store' } });
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: ScheduledController, env: AppEnv['Bindings'], executionContext: ExecutionContext) {
    if (!publicationEnabled(env)) return;
    if (missingDeploymentConfig(env).length) return;
    const { processPublicationQueue } = await import('./publication/queue.js');
    executionContext.waitUntil(processPublicationQueue(env));
  },
};
