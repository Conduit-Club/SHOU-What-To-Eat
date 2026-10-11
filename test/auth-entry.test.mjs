import assert from 'node:assert/strict';
import { test } from 'node:test';
import {handleAuthEntry} from "../src/worker/auth-entry.ts";
const origin = 'https://site.invalid';
const options = () => ({ siteKey: '0xtest', secret: 'test-only-secret', brand: '校园网站', returnTo: '/courses?q=test', ipLimiter: { limit: async () => ({ success: true }) }, siteLimiter: { limit: async () => ({ success: true }) } });
const post = (body = 'cf-turnstile-response=valid', headers = {}) => new Request(origin + '/auth/login', { method: 'POST', body, headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', 'CF-Connecting-IP': '192.0.2.1', ...headers } });
const verified = async () => Response.json({ success: true, hostname: 'site.invalid', action: 'auth-start' });
const forbiddenBegin = async () => { throw new Error('Gate rejection must not reach provider or D1'); };

test('GET, HEAD and prefetch never call provider, rate limit, or database; query secrets are not reflected', async () => {
 for (const method of ['GET','HEAD']) {
  const config = options(); config.ipLimiter.limit = config.siteLimiter.limit = forbiddenBegin;
  const response = await handleAuthEntry(new Request(origin + '/auth/register?client_secret=private-value', {method, headers: {Purpose:'prefetch'}}), config, forbiddenBegin, forbiddenBegin);
  assert.equal(response.status,200); assert.equal(response.headers.get('Cache-Control'),'private, no-store'); assert.match(response.headers.get('X-Robots-Tag'),/noindex/);
  const html=await response.text(); assert.match(html,/method="POST"/); assert.match(html,/继续注册/); assert.match(html,/disabled/); assert.doesNotMatch(html,/private-value/);
 }
});
test('cross-origin, missing origin, unexpected fetch metadata, bad content type and token fail before outbound calls', async () => {
 const cases = [ [post(undefined,{Origin:'https://evil.invalid'}),403], [post(undefined,{Origin:''}),403], [post(undefined,{'Sec-Fetch-Site':'cross-site'}),403], [post(undefined,{'Content-Type':'application/json'}),415], [post(''),400], [post('cf-turnstile-response=a&cf-turnstile-response=b'),400], [post('cf-turnstile-response='+ 'x'.repeat(2049)),400], [post('x='+ 'x'.repeat(4097)),413] ];
 for (const [request,status] of cases) { const config=options(); config.ipLimiter.limit=forbiddenBegin; assert.equal((await handleAuthEntry(request,config,forbiddenBegin,forbiddenBegin)).status,status); }
});
test('missing native limiter, secret, site key or trusted edge IP fails closed without D1', async () => {
 for (const field of ['ipLimiter','siteLimiter','secret','siteKey']) { const config=options(); config[field]=undefined; assert.equal((await handleAuthEntry(post(),config,forbiddenBegin,forbiddenBegin)).status,503); }
 assert.equal((await handleAuthEntry(post(undefined,{'CF-Connecting-IP':''}),options(),forbiddenBegin,forbiddenBegin)).status,503);
});
test('IP limiting precedes verification; site budget is consumed only after verification', async () => {
 const config=options(); config.ipLimiter.limit=async()=>({success:false});
 let response=await handleAuthEntry(post(),config,forbiddenBegin,forbiddenBegin); assert.equal(response.status,429); assert.equal(response.headers.get('Retry-After'),'60');
 config.ipLimiter.limit=async()=>({success:true}); config.siteLimiter.limit=forbiddenBegin;
 assert.equal((await handleAuthEntry(post(),config,forbiddenBegin,async()=>Response.json({success:false}))).status,400);
 config.siteLimiter.limit=async()=>({success:false}); assert.equal((await handleAuthEntry(post(),config,forbiddenBegin,verified)).status,429);
});
test('wrong hostname/action, provider errors and limiter outages never create a transaction', async () => {
 for (const result of [{success:true,hostname:'evil.invalid',action:'auth-start'},{success:true,hostname:'site.invalid',action:'submission'}]) assert.equal((await handleAuthEntry(post(),options(),forbiddenBegin,async()=>Response.json(result))).status,400);
 for (const fetcher of [async()=>new Response('',{status:503}),async()=>{throw new Error('private detail')}]) assert.equal((await handleAuthEntry(post(),options(),forbiddenBegin,fetcher)).status,503);
 const config=options(); config.ipLimiter.limit=async()=>{throw new Error('limiter unavailable')}; assert.equal((await handleAuthEntry(post(),config,forbiddenBegin,forbiddenBegin)).status,503);
});
test('verified POST starts once and duplicate token never starts again; IP keys contain no raw IP', async () => {
 let writes=0, seen=false;
 const config=options(); config.ipLimiter.limit=async({key})=>{assert.match(key,/^[a-f0-9]{64}$/); assert.ok(!key.includes('192.0.2.1')); return {success:true};};
 const fetcher=async(url,init)=>{assert.equal(url,'https://challenges.cloudflare.com/turnstile/v0/siteverify'); const body=new URLSearchParams(init.body); assert.equal(body.get('response'),'valid'); if(seen)return Response.json({success:false}); seen=true; return verified();};
 const begin=async()=>{writes++; return 'https://auth.invalid/authorize?state=unique';};
 const success=await handleAuthEntry(post(),config,begin,fetcher); assert.equal(success.status,303); assert.equal(success.headers.get('Location'),'https://auth.invalid/authorize?state=unique');
 assert.equal((await handleAuthEntry(post(),config,begin,fetcher)).status,400); assert.equal(writes,1);
});

import worker from '../src/worker/index.ts';
test('real food login/register routes keep GET and invalid POST entirely outside D1', async () => {
 const config=options();
 const env={PUBLIC_TURNSTILE_SITE_KEY:config.siteKey,TURNSTILE_SECRET_KEY:config.secret,AUTH_IP_LIMITER:config.ipLimiter,AUTH_SITE_LIMITER:config.siteLimiter,OIDC_ISSUER:'https://auth.invalid/api/auth',OIDC_CLIENT_ID:'test',OIDC_CLIENT_SECRET:'test-only-secret',OIDC_REDIRECT_URI:origin+'/auth/callback',DB:{prepare(){throw new Error('Entry request must not query D1')}}};
 for(const kind of ['login','register']) {
  const url=origin+'/auth/'+kind+'?returnTo='+encodeURIComponent('//evil.invalid');
  assert.equal((await worker.fetch(new Request(url),env,{})).status,200);
  const response=await worker.fetch(new Request(url,{method:'POST',body:'cf-turnstile-response=x',headers:{Origin:'https://evil.invalid','Content-Type':'application/x-www-form-urlencoded'}}),env,{});
  assert.equal(response.status,403);
 }
});
