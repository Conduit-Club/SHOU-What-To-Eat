import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchAccountSession, adminRequest } from '../src/utils/auth-session.ts';
import { submissionFetch } from '../src/utils/submission-request.ts';
import { loadCatalog } from '../src/utils/load-catalog.ts';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('concurrent account widgets share one request, sequential reads and retries always fetch again',async()=>{
  let calls = 0, next = deferred();
  const send = async(path,options)=>{ assert.equal(path,'/auth/session'); assert.equal(options.cache,'no-store'); assert.equal(options.credentials,'same-origin'); calls++; return next.promise; };
  const pending = [fetchAccountSession(send),fetchAccountSession(send),fetchAccountSession(send)];
  assert.equal(calls,1); next.resolve(Response.json({user:null,csrfToken:null}));
  assert.deepEqual(await Promise.all(pending),Array(3).fill({user:null,csrfToken:null}));
  next = deferred(); const failure = fetchAccountSession(send); assert.equal(calls,2);
  next.resolve(new Response('',{status:503})); await assert.rejects(failure,/账号状态/);
  next = deferred(); const retry = fetchAccountSession(send); assert.equal(calls,3);
  next.resolve(Response.json({user:null,csrfToken:null})); await retry;
});

test('admin and contribution writes bypass a pending display refresh and use newly acquired CSRF',async()=>{
  for(const write of [send=>adminRequest('/content',{method:'POST',body:'{}'},send,'/api/manage/v2'),send=>submissionFetch('/api/v2/submissions',{method:'POST',body:'{}'},send)]) {
    let sessionCalls = 0; const display = deferred(), writes = [];
    const send = async(path,init)=>{
      if(path==='/auth/session') { sessionCalls++; return sessionCalls===1 ? display.promise : Response.json({csrfToken:'renewed-csrf'}); }
      writes.push(init); return Response.json({saved:true});
    };
    const old = fetchAccountSession(send); await write(send);
    assert.equal(sessionCalls,2); assert.equal(writes[0].headers.get('X-CSRF-Token'),'renewed-csrf');
    display.resolve(Response.json({csrfToken:'old-csrf'})); await old;
  }
});

test('catalog refresh reaches the server each time and only reuses a validated body after 304',async()=>{
  const first = deferred(), calls = [], data = {foods:[],venues:[],revision:1};
  let response = first.promise;
  const send = async(path,init)=>{ assert.equal(path,'/catalog-index.json'); assert.equal(init.cache,'no-store'); calls.push(init); return response; };
  const pending = [loadCatalog(send),loadCatalog(send)]; assert.equal(calls.length,1);
  first.resolve(Response.json(data,{headers:{ETag:'"eat-catalog-v1-1"'}})); await Promise.all(pending);
  response = new Response(null,{status:304,headers:{ETag:'"eat-catalog-v1-1"'}});
  assert.deepEqual(await loadCatalog(send),data); assert.equal(calls.length,2); assert.equal(calls[1].headers['If-None-Match'],'"eat-catalog-v1-1"');
  response = Response.json({error:{code:'database_error',message:'private'}},{status:503});
  await assert.rejects(loadCatalog(send),/数据库错误/); assert.equal(calls.length,3);
  response = Response.json({...data,revision:2},{headers:{ETag:'"eat-catalog-v1-2"'}});
  assert.equal((await loadCatalog(send)).revision,2); assert.equal(calls.length,4);
  response = new Response(null,{status:304}); await loadCatalog(send);
  assert.equal(calls[4].headers['If-None-Match'],'"eat-catalog-v1-2"');
  await assert.rejects(loadCatalog(async()=>new Response(null,{status:304})),/目录暂时无法加载/);
});

test('browser returns Cloudflare weak ETag unchanged and accepts only server-confirmed 304 reuse',async()=>{
  const data={foods:[],venues:[],revision:14},weak='W/"eat-catalog-v1-14"',calls=[];
  const send=async(path,init)=>{calls.push(init);return calls.length===1?Response.json(data,{headers:{ETag:weak}}):new Response(null,{status:304});};
  assert.deepEqual(await loadCatalog(send),data);assert.deepEqual(await loadCatalog(send),data);
  assert.equal(calls.length,2);assert.equal(calls[1].headers['If-None-Match'],weak);assert.equal(calls[1].cache,'no-store');
});
