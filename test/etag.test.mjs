import test from 'node:test';
import assert from 'node:assert/strict';
import { ifNoneMatchMatches } from '../src/worker/etag.ts';

test('GET If-None-Match weak comparison supports Cloudflare tags, complete lists and standalone wildcard',()=>{
  const current = '"eat-catalog-v1-14"';
  for(const value of [current,'W/'+current,' \tW/'+current+'\t ', '"old", W/'+current, 'W/'+current+', "other"', '"comma,in,tag", W/'+current, ', , W/'+current+', ,', '*', ' \t*\t ']) {
    assert.equal(ifNoneMatchMatches(value,current),true,value);
  }
  assert.equal(ifNoneMatchMatches(current,'W/'+current),true);
});

test('old versions, opaque differences and invalid If-None-Match fields never suppress current content',()=>{
  const current = '"eat-catalog-v1-14"';
  for(const value of ['',' , , ','W/"eat-catalog-v1-13"','"eat-catalog-v1-13", "other"','"eat-catalog-v1-014"','"EAT-catalog-v1-14"','w/'+current,'W/ '+current,current+', invalid','invalid, '+current,current+' '+current,current+'junk','"unfinished', '"contains space", '+current,'*, '+current,current+', *','W/*']) {
    assert.equal(ifNoneMatchMatches(value,current),false,value);
  }
  assert.equal(ifNoneMatchMatches('"comma,in,tag"',current),false);
});
