import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadCatalog } from '../src/lib/catalog/index.ts';
import { publicCatalog, visibleImages } from '../src/lib/catalog/visibility.ts';
import { validateManagedEdit, validateManagedRelations } from '../src/lib/catalog/management.ts';
import { recommended } from '../src/utils/catalog-discovery.ts';
import { validateV2Submission, validateV2Revision } from '../src/worker/v2-validation.ts';

const catalog=loadCatalog(JSON.parse(readFileSync('.generated/catalog.json','utf8')));
const food=catalog.foods[0];
const image={url:'https://example.com/real.webp',alt:'实拍',sourceUrl:'https://example.com/source',sourceNote:null,author:'同学',license:'本人授权本站展示及选作对应内容封面',permission:'approved',isIllustrative:false,width:900,height:600,coverEligible:true};
const review={...catalog.reviews[0],id:'cover-review',targetType:'food',targetId:food.id,rating:4,text:'测试',images:[image]};

test('new food needs a photo declaration, existing photo-less revisions remain reviewable',()=>{
 const data={schemaVersion:2,entityType:'food',snapshotId:'catalog-v2-test',payload:{name:'餐品',venueId:'venue',mealTypes:['meal']},expectedImages:0,expectedReviewImages:0,turnstileToken:'token'};
 assert.throws(()=>validateV2Submission(data),e=>e.code==='food_photo_required');
 assert.equal(validateV2Submission({...data,expectedImages:1}).expectedImages,1);
 const {turnstileToken,...revision}=data;
 assert.doesNotThrow(()=>validateV2Revision(revision,{entityType:'food',snapshotId:data.snapshotId,expectedImages:0,expectedReviewImages:0}));
});
test('review cover resolves without changing source and falls back after withdrawal, hiding or revoked permission',()=>{
 const own={...image,url:'https://example.com/own.webp'};
 const entity={...food,images:[own],cover:{url:image.url,reviewId:review.id,x:30,y:70}};
 assert.deepEqual(visibleImages(entity,'food',[review])[0],{...image,position:{x:30,y:70}});
 assert.equal(review.images.length,1);
 for(const changed of [{...review,status:'archived'},{...review,targetId:'another'},{...review,images:[{...image,hidden:true}]},{...review,images:[{...image,coverEligible:false}]},{...review,images:[{...image,isIllustrative:true}]}])assert.equal(visibleImages(entity,'food',[changed])[0].url,own.url);
});
test('archived entities and their reviews disappear from public catalog but source remains recoverable',()=>{
 const input=structuredClone(catalog);const archived=input.foods[0];archived.status='archived';
 input.reviews.push({...review,targetId:archived.id});const output=publicCatalog(input);
 assert.ok(!output.foods.some(f=>f.id===archived.id));assert.ok(!output.reviews.some(r=>r.targetType==='food'&&r.targetId===archived.id));
 assert.ok(input.foods.some(f=>f.id===archived.id));
 archived.status='published';assert.ok(publicCatalog(input).foods.some(f=>f.id===archived.id));
});
test('management protects source, author and image provenance while allowing reversible hides',()=>{
 const before={...food,images:[image]};
 assert.doesNotThrow(()=>validateManagedEdit('food',before,{...before,images:[{...image,hidden:true}]}));
 assert.throws(()=>validateManagedEdit('food',before,{...before,images:[{...image,author:'changed'}]}),/image_provenance_immutable/);
 assert.throws(()=>validateManagedEdit('food',before,{...before,id:'other'}),/entity_id_immutable/);
 assert.throws(()=>validateManagedEdit('food',before,{...before,sources:[] }));
 assert.throws(()=>validateManagedEdit('review',review,{...review,text:'invented'}),/review_content_immutable/);
});
test('archive dependencies and cover scope are checked before publishing',()=>{
 const parent=catalog.restaurants.find(v=>v.id===food.venueId);
 const records=[{type:'venue',record:parent},{type:'food',record:food},{type:'review',record:review}];
 assert.throws(()=>validateManagedRelations('venue',{...parent,status:'archived'},records),/venue_has_active_children/);
 assert.throws(()=>validateManagedRelations('food',{...food,venueId:'missing'},records),/parent_venue_unpublished/);
 assert.doesNotThrow(()=>validateManagedRelations('food',{...food,cover:{url:image.url,reviewId:review.id,x:50,y:50}},records));
 assert.throws(()=>validateManagedRelations('food',{...food,cover:{url:image.url,reviewId:'wrong',x:50,y:50}},records),/invalid_cover_review/);
});
test('home recommendations temper an isolated five star rating and never invent unrated scores',()=>{
 const items=[{name:'one',rating:5,ratedCount:1},{name:'many',rating:4.8,ratedCount:20},{name:'none',rating:null,ratedCount:0}];
 assert.deepEqual(recommended(items).map(x=>x.name),['many','one']);assert.equal(items[0].rating,5);
});
