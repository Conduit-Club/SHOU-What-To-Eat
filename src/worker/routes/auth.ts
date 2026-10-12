import { handleAuthEntry } from "../auth-entry.js";
import { Hono } from 'hono';
import type { Context } from 'hono';
import { html } from 'hono/html';
import { accountUrl, safeReturnTo, authConfigured, AuthFailure, beginLogin, completeLogin, endSession, readSession } from '../auth.js';
import type { AppEnv } from '../types.js';
import { liveContent, publicationEnabled } from '../config.js';

export const authRoutes = new Hono<AppEnv>();
authRoutes.use('/*', async (context, next) => {
  context.header('Cache-Control', 'private, no-store');
  context.header('Vary', 'Cookie');
  context.header('X-Content-Type-Options', 'nosniff');
  await next();
  // Preserve the confirmation page's same-origin policy and the authorization
  // redirect's no-referrer policy; other auth responses remain private.
  if (!context.res.headers.has('Referrer-Policy')) context.header('Referrer-Policy', 'no-referrer');
});

authRoutes.get('/session', async context => {
  if (context.req.header('Origin') && context.req.header('Origin') !== new URL(context.req.url).origin) return context.json({ error: { code: 'origin_forbidden', message: '请求来源不允许。' } }, 403);
  const session = await readSession(context);
  return context.json({ configured: authConfigured(context.env, new URL(context.req.url)), directPublishing: liveContent(context.env) && publicationEnabled(context.env), user: session ? {
    username: session.username, picture: session.picture, isAdmin: session.isAdmin, wasAdmin: session.wasAdmin,
    adminExpiresAt: session.adminExpiresAt, expiresAt: session.expiresAt,
  } : null, csrfToken: session?.csrfToken ?? null });
});
authRoutes.on(['GET', 'POST'], '/login', async context => {
  try {
    if (!authConfigured(context.env, new URL(context.req.url))) throw new AuthFailure(503);
    return await handleAuthEntry(context.req.raw, {
    siteKey: context.env.PUBLIC_TURNSTILE_SITE_KEY,
    secret: context.env.TURNSTILE_SECRET_KEY,
    ipLimiter: context.env.AUTH_IP_LIMITER,
    siteLimiter: context.env.AUTH_SITE_LIMITER,
    returnTo: safeReturnTo(context.req.query('returnTo')),
    brand: '今日海大吃什么',
  }, () => beginLogin(context, false)); } catch (reason) { return failure(context, reason); }
});
authRoutes.on(['GET', 'POST'], '/register', async context => {
  try {
    if (!authConfigured(context.env, new URL(context.req.url))) throw new AuthFailure(503);
    return await handleAuthEntry(context.req.raw, {
    siteKey: context.env.PUBLIC_TURNSTILE_SITE_KEY,
    secret: context.env.TURNSTILE_SECRET_KEY,
    ipLimiter: context.env.AUTH_IP_LIMITER,
    siteLimiter: context.env.AUTH_SITE_LIMITER,
    returnTo: safeReturnTo(context.req.query('returnTo')),
    brand: '今日海大吃什么',
  }, () => beginLogin(context, true)); } catch (reason) { return failure(context, reason); }
});
authRoutes.get('/callback', async context => { try { return context.redirect(await completeLogin(context), 303); } catch (reason) { return failure(context, reason); } });
authRoutes.post('/logout', async context => { try { return context.redirect(await endSession(context), 303); } catch (reason) { return failure(context, reason); } });
authRoutes.get('/account', context => { try { return context.redirect(accountUrl(context), 303); } catch (reason) { return failure(context, reason); } });

function failure(context: Context<AppEnv>, reason: unknown) {
  // Provider exceptions can include tokens, codes and personal data. Neither
  // their message nor the callback URL is sent to the browser or logs.
  const status = reason instanceof AuthFailure ? reason.status : 503;
  const message = status === 400 ? '登录请求已失效，请重新登录。' : status === 403 ? '此账号暂时无法登录。' : '账号服务暂时不可用，请稍后重试。';
  context.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  return context.html(html`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>账号登录 · 今日海大吃什么</title><style>body{font:16px/1.7 system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:24px;color:#49362c;background:#fbf9f6}a{color:#9e310a;margin-right:24px}</style><main><h1>账号登录</h1><p>${message}</p><a href="/auth/login">重新登录</a><a href="/">返回首页</a></main></html>`, status);
}
