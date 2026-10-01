import test from 'node:test';
import assert from 'node:assert/strict';
import { newest,topRated,imageShape,matchesDiscoveryVenue } from '../src/utils/catalog-discovery.ts';
import { discoveryCatalog } from '../src/lib/catalog/discovery.ts';
import { loadCatalog } from '../src/lib/catalog/index.ts';
import { readFile } from 'node:fs/promises';
test('rated shelves exclude unrated legacy notes and new shelves exclude unknown dates',()=>{
  const items=[{name:'旧文字评价',rating:null,addedAt:null},{name:'最近收录',rating:3,addedAt:'2026-10-01'},{name:'更高评分',rating:5,addedAt:'2026-09-30'}];
  assert.deepEqual(topRated(items).map(item=>item.name),['更高评分','最近收录']);
  assert.deepEqual(newest(items).map(item=>item.name),['最近收录','更高评分']);
  assert.deepEqual(newest([{name:'旧资料',addedAt:null}]),[]);
});
test('the first photo can determine a wide, portrait or regular card without guessing missing dimensions',()=>{
  assert.equal(imageShape(1800,900),'wide');assert.equal(imageShape(900,1600),'portrait');assert.equal(imageShape(1200,1000),'regular');
  for(const [width,height] of [[null,null],[0,20],[Infinity,20],[-1,10]])assert.equal(imageShape(width,height),'regular');
});
test('venue search respects the same-food constraint and ignores unknown campus distance',()=>{
  const venue={id:'v',name:'二餐',category:'on-campus',kind:'cafeteria',location:{address:'二餐二楼'},tags:[],images:[],description:null,averagePrice:null,reviewCount:0,rating:null,addedAt:null};
  const foods=[{id:'f1',name:'早餐面',venueId:'v',venue,mealTypes:['breakfast'],price:{amountCents:800},tags:[],description:null,images:[],reviewCount:0,rating:null},{id:'f2',name:'晚餐饭',venueId:'v',venue,mealTypes:['meal'],price:{amountCents:2300},tags:['spicy'],description:null,images:[],reviewCount:0,rating:null}];
  const filters={scope:'all',meal:'breakfast',budget:'15to25',tags:[],query:''};
  assert.equal(matchesDiscoveryVenue(venue,foods,filters),false);
  assert.equal(matchesDiscoveryVenue(venue,foods,{...filters,meal:'meal',tags:['spicy'],query:'二餐二楼'}),true);
  assert.equal(matchesDiscoveryVenue(venue,foods,{...filters,meal:'all',budget:'all',scope:'within-500'}),false);
});
test('generated discovery JSON contains published catalog facts and no private submission state',async()=>{
  const catalog=JSON.parse(await readFile(new URL('../.generated/catalog.json',import.meta.url),'utf8'));
  const discovery=discoveryCatalog(loadCatalog(catalog));
  assert.equal(discovery.foods.length,catalog.foods.length);assert.equal(discovery.venues.length,catalog.restaurants.length);
  assert.doesNotMatch(JSON.stringify(discovery),/receiptToken|receipt_hash|parentReceiptToken|original_json|reviewer|privateNote/);
  const fish=discovery.foods.find(food=>food.id==='812a5c7e-4ca2-40e1-86e6-2c1ed0ef2534');
  assert.equal(fish.price.amountCents,1900);assert.equal(fish.addedAt,'2026-10-01');assert.equal(fish.rating,null);
});
