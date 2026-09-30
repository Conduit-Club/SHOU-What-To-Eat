import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const contentDir = new URL('../src/content/restaurants/', import.meta.url);
const records = await Promise.all((await readdir(contentDir)).filter((file) => file.endsWith('.json')).map(async (file) => JSON.parse(await readFile(new URL(file, contentDir), 'utf8'))));

test('migrates all legacy and guide entries without duplicate IDs', () => {
  assert.equal(records.length, 19);
  assert.equal(new Set(records.map((record) => record.id)).size, 19);
  assert.equal(records.filter((record) => record.category === 'on-campus').length, 8);
  assert.equal(records.filter((record) => record.category === 'off-campus').length, 11);
});

test('every migrated record keeps location, price and source provenance', () => {
  for (const record of records) {
    assert.ok(record.name, record.id);
    assert.ok(record.location, record.id);
    assert.ok(record.price, record.id);
    assert.ok(record.sources?.length, record.id);
    assert.ok(record.visitedAt === undefined || record.visitedAt === null || typeof record.visitedAt === 'string', record.id);
  }
});

test('all public external images use HTTPS and have alt text and permission state', () => {
  for (const record of records) for (const image of record.images ?? []) {
    assert.match(image.url, /^https:\/\//);
    assert.ok(image.alt);
    assert.ok(image.permission);
  }
});

test('preserves the multiple student reviews and ambiguous location notes', () => {
  assert.ok(records.find((record) => record.id === 'first-canteen').reviews.length >= 5);
  assert.ok(records.find((record) => record.id === 'second-canteen').foods.some((food) => food.name.includes('肠粉')));
  assert.match(records.find((record) => record.id === 'changfen').location, /待补充/);
});
