import test from 'node:test';
import assert from 'node:assert/strict';
import { createReview, completeReview, ReviewRequestError } from '../src/utils/review-submission.ts';
const input={snapshotId:'catalog-v2-test',targetType:'food',targetId:'dish-a',rating:4,text:'本地测试',imageCount:0,turnstileToken:'local-test-token',idempotencyKey:'one-stable-request-key'};
const receipt={submissionId:'submission-a',receiptToken:'local-test-receipt',version:1,type:'review',expectedImages:0,expectedReviewImages:0};
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const photo={blob:new Blob(['local-test-webp'],{type:'image/webp'}),alt:'本地测试照片',source:'本人拍摄',holder:'测试者',license:'本人授权本站展示',rightsConfirmed:true,isIllustrative:false};
test('quick reviews use the existing moderated endpoint and retain a private receipt',async()=>{
  const result=await createReview(input,async(path,options)=>{
    assert.equal(path,'/api/v2/submissions');
    assert.equal(options.headers['Idempotency-Key'],input.idempotencyKey);
    const body=JSON.parse(options.body);assert.equal(body.entityType,'review');assert.equal(body.expectedReviewImages,0);assert.deepEqual(body.payload,{targetType:'food',targetId:'dish-a',rating:4,text:'本地测试'});
    return response({submissionId:receipt.submissionId,receiptToken:receipt.receiptToken,version:1},202);
  });
  assert.deepEqual(result,receipt);
});
test('rating bounds, photo count and Unicode character limit are checked before sending',async()=>{
  const noFetch=async()=>{throw new Error('must not send');};
  for(const change of [{rating:0},{rating:6},{rating:1.5},{imageCount:4},{text:'🍜'.repeat(257)}]) await assert.rejects(createReview({...input,...change},noFetch),/1–5/);
  await createReview({...input,text:'🍜'.repeat(256)},async()=>response({submissionId:'s',receiptToken:'t',version:1},202));
});
test('permission, Turnstile, limit and replay failures preserve error codes',async()=>{
  for(const [status,code] of [[403,'turnstile_failed'],[404,'not_found'],[409,'idempotency_replayed'],[429,'rate_limited']]) {
    await assert.rejects(createReview(input,async()=>response({error:{code,message:'本地错误'},submissionId:'already-saved'},status)),error=>error instanceof ReviewRequestError&&error.code===code&&error.status===status&&error.submissionId==='already-saved');
  }
});
test('resume checks the receipt and skips saved photos before versioned finalization',async()=>{
  const versions=[];const calls=[];
  const result=await completeReview({...receipt,expectedImages:2},[photo,photo],version=>versions.push(version),async(path,options)=>{
    calls.push(path);assert.equal(options.headers.Authorization,'Bearer '+receipt.receiptToken);
    if(path.endsWith('/status')) return response({version:2,uploadedImages:1,uploadState:'uploading'});
    if(path.endsWith('/images')) {assert.equal(options.headers['X-Image-Index'],'1');assert.equal(options.headers['X-Submission-Version'],'2');assert.equal(decodeURIComponent(options.headers['X-Image-Alt']),photo.alt);return response({version:3},201);}
    assert.deepEqual(JSON.parse(options.body),{expectedVersion:3,expectedImages:2,expectedReviewImages:0});return response({version:4});
  });
  assert.equal(result,4);assert.deepEqual(versions,[2,3,4]);assert.equal(calls.length,3);
});
test('a lost upload response can resume from server state without overwriting or duplicating',async()=>{
  const versions=[];const withPhoto={...receipt,expectedImages:1};
  await assert.rejects(completeReview(withPhoto,[photo],v=>versions.push(v),async(path)=>path.endsWith('/status')?response({version:1,uploadedImages:0,uploadState:'uploading'}):Promise.reject(new Error('network lost'))),/network lost/);
  const result=await completeReview(withPhoto,[],v=>versions.push(v),async(path)=>{
    assert.equal(path.endsWith('/images'),false);return path.endsWith('/status')?response({version:2,uploadedImages:1,uploadState:'uploading'}):response({version:3});
  });
  assert.equal(result,3);assert.deepEqual(versions,[1,2,3]);
});
test('resuming missing photos requires the original batch, and photo rights are mandatory',async()=>{
  const status=async()=>response({version:1,uploadedImages:0,uploadState:'uploading'});
  await assert.rejects(completeReview({...receipt,expectedImages:2},[photo],()=>{},status),/原来的 2/);
  await assert.rejects(completeReview({...receipt,expectedImages:1},[{...photo,rightsConfirmed:false}],()=>{},status),/使用权/);
});
test('already completed reviews need no re-upload or second finalization',async()=>{
  let calls=0;assert.equal(await completeReview({...receipt,expectedImages:1},[],()=>{},async()=>{calls++;return response({version:3,uploadedImages:1,uploadState:'pending'});}),3);assert.equal(calls,1);
});
