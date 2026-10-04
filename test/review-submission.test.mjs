import test from 'node:test';
import assert from 'node:assert/strict';
import { createReview, completeReview, ReviewRequestError } from '../src/utils/review-submission.ts';
import { submissionFetch } from '../src/utils/submission-request.ts';
const input={snapshotId:'catalog-v2-test',targetType:'food',targetId:'dish-a',rating:4,text:'本地测试',imageCount:0,turnstileToken:'local-test-token',idempotencyKey:'one-stable-request-key'};
const receipt={submissionId:'submission-a',receiptToken:'local-test-receipt',version:1,type:'review',expectedImages:0,expectedReviewImages:0};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const photo={blob:new Blob(['local-test-webp'],{type:'image/webp'}),alt:'本地测试照片',source:'本人拍摄',holder:'测试者',license:'本人授权本站展示',rightsConfirmed:true,isIllustrative:false};
const transport=(send,session={configured:true,user:null,csrfToken:null})=>async(path,options)=>path==='/auth/session'?response(session):send(path,options);
test('quick reviews use the existing moderated endpoint and retain a private receipt',async()=>{
  const result=await createReview(input,transport(async(path,options)=>{
    assert.equal(path,'/api/v2/submissions');
    assert.equal(new Headers(options.headers).get('Idempotency-Key'),input.idempotencyKey);
    assert.equal(JSON.parse(options.body).visibility,'anonymous');
    const body=JSON.parse(options.body);assert.equal(body.entityType,'review');assert.equal(body.expectedReviewImages,0);assert.deepEqual(body.payload,{targetType:'food',targetId:'dish-a',rating:4,text:'本地测试'});
    return response({submissionId:receipt.submissionId,receiptToken:receipt.receiptToken,version:1},202);
  }));
  assert.deepEqual(result,receipt);
});
test('rating bounds, photo count and Unicode character limit are checked before sending',async()=>{
  const noFetch=async()=>{throw new Error('must not send');};
  for(const change of [{rating:0},{rating:6},{rating:1.5},{imageCount:4},{text:'🍜'.repeat(257)}]) await assert.rejects(createReview({...input,...change},noFetch),/1–5/);
  await createReview({...input,text:'🍜'.repeat(256)},transport(async()=>response({submissionId:'s',receiptToken:'t',version:1},202)));
});
test('quick review transport preserves the chosen dining date and omits identity snapshots',async()=>{
  await createReview({...input,visitedAt:'2026-10-01',visibility:'username'},transport(async(path,options)=>{
    const body=JSON.parse(options.body);assert.equal(body.payload.visitedAt,'2026-10-01');assert.equal(body.visibility,'username');
    assert.doesNotMatch(options.body,/authorAlias|authorAvatar|userId|subject/);
    return response({submissionId:'s',receiptToken:'t',version:1},202);
  }));
});
test('permission, Turnstile, limit and replay failures preserve error codes',async()=>{
  for(const [status,code] of [[403,'turnstile_failed'],[404,'not_found'],[409,'idempotency_replayed'],[429,'rate_limited']]) {
    await assert.rejects(createReview(input,transport(async()=>response({error:{code,message:'本地错误'},submissionId:'already-saved'},status))),error=>error instanceof ReviewRequestError&&error.code===code&&error.status===status&&error.submissionId==='already-saved');
  }
});
test('resume checks the receipt and skips saved photos before versioned finalization',async()=>{
  const versions=[];const calls=[];
  const result=await completeReview({...receipt,expectedImages:2},[photo,photo],version=>versions.push(version),transport(async(path,options)=>{
    calls.push(path);const headers=new Headers(options.headers);assert.equal(headers.get('Authorization'),'Bearer '+receipt.receiptToken);
    if(path.endsWith('/status')) return response({version:2,uploadedImages:1,uploadState:'uploading'});
    if(path.endsWith('/images')) {assert.equal(headers.get('X-Image-Index'),'1');assert.equal(headers.get('X-Submission-Version'),'2');assert.equal(decodeURIComponent(headers.get('X-Image-Alt')),photo.alt);return response({version:3},201);}
    assert.deepEqual(JSON.parse(options.body),{expectedVersion:3,expectedImages:2,expectedReviewImages:0});return response({version:4});
  }));
  assert.deepEqual(result,{version:4,status:'pending'});assert.deepEqual(versions,[2,3,4]);assert.equal(calls.length,3);
});
test('a lost upload response can resume from server state without overwriting or duplicating',async()=>{
  const versions=[];const withPhoto={...receipt,expectedImages:1};
  await assert.rejects(completeReview(withPhoto,[photo],v=>versions.push(v),transport(async(path)=>path.endsWith('/status')?response({version:1,uploadedImages:0,uploadState:'uploading'}):Promise.reject(new Error('network lost')))),/network lost/);
  const result=await completeReview(withPhoto,[],v=>versions.push(v),transport(async(path)=>{
    assert.equal(path.endsWith('/images'),false);return path.endsWith('/status')?response({version:2,uploadedImages:1,uploadState:'uploading'}):response({version:3});
  }));
  assert.deepEqual(result,{version:3,status:'pending'});assert.deepEqual(versions,[1,2,3]);
});
test('resuming missing photos requires the original batch, and photo rights are mandatory',async()=>{
  const status=async()=>response({version:1,uploadedImages:0,uploadState:'uploading'});
  await assert.rejects(completeReview({...receipt,expectedImages:2},[photo],()=>{},status),/原来的 2/);
  await assert.rejects(completeReview({...receipt,expectedImages:1},[{...photo,rightsConfirmed:false}],()=>{},status),/使用权/);
});
test('already completed reviews need no re-upload or second finalization',async()=>{
  let calls=0;assert.deepEqual(await completeReview({...receipt,expectedImages:1},[],()=>{},async()=>{calls++;return response({version:3,uploadedImages:1,uploadState:'pending'});}),{version:3,status:'pending'});assert.equal(calls,1);
});

test('direct drafts finalize with freshly read CSRF while published retries only read committed status',async()=>{
  const session={configured:true,user:{username:'海大学生'},csrfToken:'new-csrf'};
  const result=await createReview({...input,visibility:'username'},transport(async(path,options)=>{
    assert.equal(new Headers(options.headers).get('X-CSRF-Token'),'new-csrf');assert.equal(JSON.parse(options.body).visibility,'username');
    return response({submissionId:'submission-a',receiptToken:'local-test-receipt',version:1,status:'pending',publicationMode:'direct'},202);
  },session));
  assert.equal(result.publicationMode,'direct');
  const calls=[];
  assert.deepEqual(await completeReview(result,[],()=>{},transport(async(path,options)=>{
    calls.push(path);
    if(path.endsWith('/status'))return response({version:1,uploadedImages:0,uploadState:'pending',status:'pending',publicationMode:'direct'});
    assert.equal(new Headers(options.headers).get('X-CSRF-Token'),'new-csrf');return response({version:2,status:'published'});
  },session)),{version:2,status:'published'});
  assert.equal(calls.length,2);
  for(const status of ['published','deployed']) {
    let reads=0;assert.deepEqual(await completeReview(result,[],()=>{},async()=>{reads++;return response({version:2,uploadedImages:0,uploadState:'pending',status,publicationMode:'direct'});}),{version:2,status:'published'});assert.equal(reads,1);
  }
});
test('an unavailable account read never silently downgrades a direct post to anonymous',async()=>{
  const calls=[];
  await assert.rejects(submissionFetch('/api/v2/submissions',{method:'POST'},async(path)=>{calls.push(path);return response({error:{}},503);}),/账号状态/);
  assert.deepEqual(calls,['/auth/session']);
});
