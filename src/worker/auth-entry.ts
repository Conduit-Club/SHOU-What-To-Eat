// This gate runs before provider discovery, session reads and all D1 writes.
export type LoginLimiter = { limit(options: { key: string }): Promise<{ success: boolean }> };
type EntryOptions = {
  siteKey?: string;
  secret?: string;
  ipLimiter?: LoginLimiter;
  siteLimiter?: LoginLimiter;
  returnTo: string;
  brand: string;
};
const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);

function entryPage(url: URL, options: EntryOptions, status = 200, message = "请完成验证，然后继续前往统一账号中心。") {
  const register = url.pathname.endsWith("/register");
  const query = new URLSearchParams({ returnTo: options.returnTo });
  const action = `${url.pathname}?${query}`;
  const alternate = `/auth/${register ? "login" : "register"}?${query}`;
  const headers = new Headers({ "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer", "X-Content-Type-Options": "nosniff" });
  if (status === 503) headers.set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
  if (status === 429) headers.set("Retry-After", "60");
  return new Response(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${register ? "注册" : "登录"} · ${escape(options.brand)}</title>
<style>html{color-scheme:light dark}body{margin:0;min-height:100svh;display:grid;place-items:center;font:16px/1.7 system-ui,sans-serif;background:#fbf9f6;color:#49362c}main{box-sizing:border-box;width:min(100% - 32px,480px);margin:32px 0;padding:32px;border:1px solid #dfc3c8;border-radius:24px;background:#faf0e4}h1{margin:12px 0}p{overflow-wrap:anywhere}.challenge{min-height:70px;max-width:100%;overflow:hidden}button{width:100%;margin:20px 0;padding:14px;border:0;border-radius:14px;background:#e9a5b2;color:#35231b;font:inherit;font-weight:700;cursor:pointer}button:disabled{opacity:.55;cursor:default}a{color:#984b5c}.links{display:flex;flex-wrap:wrap;gap:20px}.notice{min-height:3.4em}@media(prefers-color-scheme:dark){body{background:#231d1b;color:#f4e9df}main{background:#302622;border-color:#655053}a{color:#e9a5b2}}</style>
</head><body><main><p>${escape(options.brand)}</p><h1>${register ? "注册统一账号" : "登录统一账号"}</h1><p class="notice" role="status" id="notice">${escape(message)}</p>
<form method="POST" action="${escape(action)}"><div id="challenge" class="challenge"></div><button id="continue" disabled>继续${register ? "注册" : "登录"}</button></form><div class="links"><a href="${escape(alternate)}">${register ? "已有账号？去登录" : "没有账号？去注册"}</a><a href="${escape(options.returnTo)}">返回网站</a></div><noscript><p>请启用 JavaScript 后完成验证。</p></noscript></main>
<script>const button=document.getElementById('continue'),notice=document.getElementById('notice');window.authChallengeReady=()=>{turnstile.render('#challenge',{sitekey:${JSON.stringify(options.siteKey ?? "").replace(/</g, "\\u003c")},action:'auth-start',size:matchMedia('(max-width:420px)').matches?'compact':'flexible',callback:()=>{button.disabled=false;notice.textContent='验证完成，可以继续。'},'expired-callback':()=>{button.disabled=true;notice.textContent='验证已过期，请重新验证。'},'error-callback':()=>{button.disabled=true;notice.textContent='验证暂时不可用，请刷新后重试。'}})};document.querySelector('form').addEventListener('submit',()=>{button.disabled=true;button.textContent='正在前往账号中心…'});</script><script src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=authChallengeReady&amp;render=explicit" async defer></script></body></html>`, { status, headers });
}

export async function handleAuthEntry(request: Request, options: EntryOptions, begin: () => Promise<string>, fetcher: typeof fetch = fetch): Promise<Response> {
  const url = new URL(request.url);
  const reject = (status: number, message: string) => entryPage(url, options, status, message);
  if (!options.secret || !/^0x[A-Za-z0-9_-]+$/.test(options.siteKey ?? "") || !options.ipLimiter || !options.siteLimiter) {
    return reject(503, "账号服务暂时不可用，请稍后重试。");
  }
  // GET/HEAD (including link scanners and prefetch) never create a transaction.
  if (request.method === "GET" || request.method === "HEAD") return entryPage(url, options);
  if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, HEAD, POST", "Cache-Control": "no-store" } });
  if (request.headers.get("Origin") !== url.origin || (request.headers.has("Sec-Fetch-Site") && request.headers.get("Sec-Fetch-Site") !== "same-origin")) return reject(403, "请求来源不允许，请从本站重新进入。");
  if (request.headers.get("Content-Type")?.split(";")[0].trim() !== "application/x-www-form-urlencoded") return reject(415, "请使用登录页面继续。");
  // Bound the actual stream, not just the client-supplied Content-Length.
  const reader = request.body?.getReader();
  if (!reader) return reject(400, "请重新完成人机验证。");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return reject(413, "请求内容过大，请重新进入登录页面。"); }
      chunks.push(value);
    }
  } catch { return reject(400, "请求读取失败，请重试。"); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  const form = new URLSearchParams(new TextDecoder().decode(bytes));
  const tokens = form.getAll("cf-turnstile-response");
  if (tokens.length !== 1 || !tokens[0] || tokens[0].length > 2048) return reject(400, "请重新完成人机验证。");
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip) return reject(503, "账号服务暂时不可用，请稍后重试。");
  try {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${url.hostname}:${ip}`));
    const key = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (!(await options.ipLimiter.limit({ key })).success) return reject(429, "操作过于频繁，请一分钟后重试。");
    const response = await fetcher("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: new URLSearchParams({ secret: options.secret, response: tokens[0], remoteip: ip }), signal: AbortSignal.timeout(10000) });
    if (!response.ok) return reject(503, "验证服务暂时不可用，请稍后重试。");
    const result: { success?: boolean; hostname?: string; action?: string } = await response.json();
    // Siteverify consumes each token once: duplicate clicks cannot create extra
    // login transactions. Never retry verification with a fresh idempotency key.
    if (result.success !== true || result.hostname !== url.hostname || result.action !== "auth-start") return reject(400, "验证已失效，请重新验证后继续。");
    // Invalid tokens cannot exhaust the site-wide allowance. This native
    // limiter is local to each Cloudflare location, not an exact daily cap.
    if (!(await options.siteLimiter.limit({ key: url.hostname })).success) return reject(429, "当前登录人数较多，请一分钟后重试。");
  } catch { return reject(503, "验证服务暂时不可用，请稍后重试。"); }
  const destination = await begin();
  return new Response(null, { status: 303, headers: { Location: destination, "Cache-Control": "private, no-store", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow" } });
}
