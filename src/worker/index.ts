import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Context } from 'hono';
import { submissionRoutes } from './routes/submissions.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';
import { missingDeploymentConfig, publicationEnabled } from './config.js';
import type { AppEnv } from './types.js';

const app = new Hono<AppEnv>();
app.use('/api/*', cors({ origin: (origin, context) => (context.env.ALLOWED_ORIGINS ?? '').split(',').map((item: string) => item.trim()).includes(origin) ? origin : null, allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'Cf-Access-Jwt-Assertion', 'Idempotency-Key'] }));
const health = (context: Context<AppEnv>) => {
  const enabled = publicationEnabled(context.env);
  const ready = !enabled || missingDeploymentConfig(context.env).length === 0;
  return context.json({ status: ready ? 'ok' : 'unavailable', mode: enabled ? 'full' : 'catalog-only' }, ready ? 200 : 503, { 'Cache-Control': 'no-store' });
};
app.get('/api/health', health);
app.get('/api/v1/health', health);
app.route('/api/v1/submissions', submissionRoutes);
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v1/webhooks', webhookRoutes);
app.notFound((context) => context.json({ error: { code: 'not_found', message: '没有找到该 API。' } }, 404, { 'Cache-Control': 'no-store' }));
app.onError((_error, context) => context.json({ error: { code: 'internal_error', message: '请求暂时无法处理。' } }, 500, { 'Cache-Control': 'no-store' }));

export default {
  fetch(request: Request, env: AppEnv['Bindings'], executionContext: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) return app.fetch(request, env, executionContext);
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
