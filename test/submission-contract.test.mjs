import test from 'node:test';
import assert from 'node:assert/strict';
import { parseYuan,splitTags } from '../src/lib/submission-limits.ts';
import { validateV2Submission } from '../src/worker/v2-validation.ts';
import { validateImageMetadata } from '../src/worker/media.ts';
const envelope={schemaVersion:2,snapshotId:'catalog-v2-test',expectedImages:0,expectedReviewImages:0,turnstileToken:'test-token'};
const venue={name:'一餐二楼',type:'stall',campusScope:'on-campus',location:{address:'第一食堂二楼'},tags:[],averagePrice:null};
const food={name:'酸菜鱼',venueId:'venue-1',mealType:'meal',tags:[],price:{amountCents:1900,currency:'CNY',unit:'份',source:'菜单'}};
const validate=(type,payload,extra={})=>validateV2Submission({...envelope,entityType:type,payload,...extra});
test('decimal yuan is exact and refuses silent rounding, signs and exponent notation',()=>{
  assert.equal(parseYuan('19'),1900);assert.equal(parseYuan('0.01'),1);assert.equal(parseYuan('19.90'),1990);assert.equal(parseYuan('100000'),10000000);
  for(const value of ['19.001','1e2','-1','NaN','Infinity','100000.01','', '+19'])assert.equal(parseYuan(value),null,value);
  assert.deepEqual(splitTags('微辣， 鱼类、下饭, 实惠'),['微辣','鱼类','下饭','实惠']);
});
test('submission text stays within the bounds that can actually be published',()=>{
  assert.doesNotThrow(()=>validate('food',{...food,name:'餐'.repeat(120),description:'餐'.repeat(1000)}));
  for(const [type,payload,code] of [
    ['food',{...food,name:'餐'.repeat(121)},'invalid_name'],
    ['food',{...food,description:'餐'.repeat(1001)},'invalid_description'],
    ['venue',{...venue,location:{address:'路'.repeat(301)}},'invalid_address'],
    ['food',{...food,price:{...food.price,source:'菜'.repeat(301)}},'invalid_price_source'],
    ['food',{...food,price:{...food.price,unit:'份'.repeat(21)}},'invalid_price_unit'],
  ])assert.throws(()=>validate(type,payload),error=>error.code===code);
});
test('unrecognized and private fields never enter the versioned public revision',()=>{
  for(const extra of [{privateNote:'secret'},{reviewer:'person'},{images:[{url:'https://example.com/unmoderated.webp'}]},{parentReceiptToken:'secret'}])assert.throws(()=>validate('venue',{...venue,...extra}),error=>error.code==='unknown_fields');
  assert.throws(()=>validate('venue',venue,{privateNote:'secret'}),error=>error.code==='unknown_fields');
  assert.throws(()=>validate('food',food,{parent:{venueEntityId:'other-venue',parentReceiptToken:'secret'}}),error=>error.code==='parent_venue_mismatch');
  const result=validate('food',food,{parent:{venueEntityId:'venue-1',parentReceiptToken:'private-token'}});
  assert.doesNotMatch(JSON.stringify(result.publicJson),/private-token|turnstileToken|parentReceiptToken/);
});
test('strict prices, campus distance, tags and alternate fields cannot contradict each other',()=>{
  for(const price of [{minCents:2000,maxCents:1000,source:'菜单'},{amountCents:19.5,source:'菜单'},{amountCents:1900,source:'菜单',currency:'USD'},{amountCents:1900,minCents:1900,maxCents:1900,source:'菜单'}])assert.throws(()=>validate('food',{...food,price}));
  assert.doesNotThrow(()=>validate('food',{...food,price:{...food.price,minCents:null,maxCents:null}}));
  assert.throws(()=>validate('venue',{...venue,location:{address:'校内',distanceMeters:500,distanceBasis:'walking'}}),error=>error.code==='on_campus_distance');
  assert.throws(()=>validate('food',{...food,tags:['微辣',' 微辣 ']}),error=>error.code==='invalid_tags');
  assert.throws(()=>validate('venue',{...venue,kind:'cafeteria'}),error=>error.code==='ambiguous_venue');
  assert.throws(()=>validate('venue',{...venue,campusScope:['on-campus']}),error=>error.code==='invalid_campus_scope');
  assert.throws(()=>validate('venue',{...venue,foods:['unsubmitted-food']}),error=>error.code==='invalid_foods');
  assert.throws(()=>validate('venue',{...venue,sources:[{repository:'source',path:'x',revision:'x',sourceUrl:'https://user:pass@example.com/photo'}]}),error=>error.code==='invalid_sources');
});
test('optional attached review keeps Unicode text and its own image declaration',()=>{
  const plain=validate('food',food);assert.equal(plain.attachedReview,null);
  const attached=validate('food',{...food,attachedReview:{rating:4,text:'😀'.repeat(256)}},{expectedImages:1,expectedReviewImages:2});
  assert.equal(attached.attachedReview.text.length,512);assert.equal(attached.expectedImages,1);assert.equal(attached.expectedReviewImages,2);
  assert.throws(()=>validate('food',{...food,attachedReview:{rating:0,text:'不错'}}));
  assert.throws(()=>validate('food',food,{expectedReviewImages:1}),error=>error.code==='review_images_without_review');
});
test('photo metadata matches the public catalog and never accepts approval from a submitter',()=>{
  const base={'X-Image-Metadata-Encoding':'percent-utf8','X-Image-Alt':encodeURIComponent('酸菜鱼'),'X-Image-Source':encodeURIComponent('本人拍摄'),'X-Image-Copyright-Holder':encodeURIComponent('匿名同学'),'X-Image-License':encodeURIComponent('本人授权展示'),'X-Image-Rights-Confirmed':'true','X-Image-Is-Illustrative':'false'};
  assert.ok(validateImageMetadata(new Headers(base)));
  for(const [field,value] of [['X-Image-Copyright-Holder','人'.repeat(161)],['X-Image-License','许'.repeat(121)],['X-Image-Source','https://user:pass@example.com/photo']])assert.equal(validateImageMetadata(new Headers({...base,[field]:encodeURIComponent(value)})),null);
  assert.equal(validateImageMetadata(new Headers({...base,'X-Image-Permission':'approved'})),null);
});
