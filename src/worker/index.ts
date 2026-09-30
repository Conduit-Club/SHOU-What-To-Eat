import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { submissionRoutes } from './routes/submissions.js';
import { adminRoutes } from './routes/admin.js';
import { webhookRoutes } from './routes/webhooks.js';
import type { AppEnv } from './types.js';

const app = new Hono<AppEnv>();
app.use('/api/*', cors({ origin: (origin, context) => (context.env.ALLOWED_ORIGINS ?? '').split(',').map((item) => item.trim()).includes(origin) ? origin : null, allowMethods: ['GET', 'POST', 'PATCH', 'OPTIONS'], allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key'] }));
app.route('/api/v1/submissions', submissionRoutes);
app.route('/api/v1/admin', adminRoutes);
app.route('/api/v1/webhooks', webhookRoutes);
app.onError((error, context) => context.json({ error: { code: 'internal_error', message: '请求暂时无法处理。' } }, 500, { 'Cache-Control': 'no-store' }));

export default {
  fetch(request: Request, env: AppEnv['Bindings'], executionContext: ExecutionContext) {
    const url = new URL(request.url);
    if (url.pathname.startsWith('/api/')) return app.fetch(request, env, executionContext);
    return env.ASSETS.fetch(request);
  },
  async scheduled(_event: ScheduledController, env: AppEnv['Bindings'], executionContext: ExecutionContext) {
    const { processPublicationQueue } = await import('./publication/queue.js');
    executionContext.waitUntil(processPublicationQueue(env));
  },
};
