import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesDiscoveryFood, pickFoodId } from '../src/utils/food-discovery.ts';
const filters = { scope:'all', budget:'all', meal:'all', tags:[], query:'' };
const food = { id:'noodles', name:'牛肉面', venueId:'canteen', venue:{ id:'canteen',name:'一餐二楼',category:'on-campus',location:{address:'第一食堂'},tags:[] }, mealTypes:['meal'], tags:['noodles'], description:null, price:{amountCents:1900,unit:'份'}, images:[],reviewCount:0,rating:null };
const matches = (item,override) => matchesDiscoveryFood(item,{...filters,...override});
test('all food conditions must match the same dish',()=>{
  assert.equal(matches(food,{meal:'meal',tags:['noodles'],budget:'15to25',scope:'on-campus'}),true);
  assert.equal(matches(food,{tags:['noodles','rice']}),false);
  assert.equal(matches({...food,mealTypes:['breakfast']},{meal:'meal'}),false);
});
test('unknown prices never satisfy a selected budget; exact boundaries work',()=>{
  assert.equal(matches({...food,price:null},{budget:'under15'}),false);
  assert.equal(matches({...food,price:{amountCents:1500}},{budget:'under15'}),false);
  assert.equal(matches({...food,price:{amountCents:1500}},{budget:'15to25'}),true);
  assert.equal(matches({...food,price:{amountCents:2500}},{budget:'15to25'}),true);
  assert.equal(matches({...food,price:{amountCents:2500}},{budget:'over25'}),false);
  assert.equal(matches({...food,price:{minCents:1200,maxCents:1600}},{budget:'15to25'}),true);
});
test('distance filters require an off-campus venue with a known measurement basis',()=>{
  const external = {...food,venue:{...food.venue,category:'off-campus',location:{distanceMeters:500,distanceBasis:'walking'}}};
  assert.equal(matches(external,{scope:'within-500'}),true);
  assert.equal(matches({...external,venue:{...external.venue,location:{distanceMeters:501,distanceBasis:'walking'}}},{scope:'within-500'}),false);
  assert.equal(matches({...external,venue:{...external.venue,location:{distanceMeters:100,distanceBasis:null}}},{scope:'within-1000'}),false);
  assert.equal(matches(food,{scope:'within-2000'}),false);
});
test('search matches the food, venue, location and translated tag',()=>{
  for(const query of ['牛肉','一餐二楼','第一食堂','面食']) assert.equal(matches(food,{query}),true,query);
  assert.equal(matches(food,{query:'不存在的餐品'}),false);
});
test('random picks stay in the filtered list and do not repeat when alternatives exist',()=>{
  const items=[{id:'a'},{id:'b'},{id:'c'}];
  assert.equal(pickFoodId(items,'b',()=>0),'a');
  assert.equal(pickFoodId(items,'b',()=>.99),'c');
  assert.equal(pickFoodId([{id:'only'}],'only'),'only');
  assert.equal(pickFoodId([],'a'),null);
});

test('price ranges intersect budgets and Chinese filter vocabulary matches legacy aliases',()=>{
 const ranged={...food,price:{minCents:1400,maxCents:2700}};
 for(const budget of ['under15','15to25','over25'])assert.equal(matches(ranged,{budget}),true);
 assert.equal(matches({...food,price:{minCents:2500,maxCents:2500}},{budget:'over25'}),false);
 assert.equal(matches(food,{tags:['面食']}),true);
 assert.equal(matches({...food,tags:['面食']},{tags:['noodles']}),true);
});
