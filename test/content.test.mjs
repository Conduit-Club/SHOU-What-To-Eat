import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { loadCatalog, generateCatalogSnapshot } from '../src/lib/catalog/index.ts';

async function readCollection(name) {
  const directory = new URL(`../src/content/${name}/`, import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith('.json')).sort();
  return Promise.all(files.map(async (file) => JSON.parse(await readFile(new URL(file, directory), 'utf8'))));
}

const rawCatalog = {
  restaurants: await readCollection('restaurants'),
  foods: await readCollection('foods'),
  reviews: await readCollection('reviews'),
};
const catalog = loadCatalog(rawCatalog);

test('migrated content has stable IDs and valid relationships', () => {
  assert.deepEqual(catalog.restaurants.map((venue) => venue.id).sort(), [
    'area-a-711', 'area-b-711', 'first-canteen', 'flavor-restaurant', 'mixue-second-canteen', 'second-canteen', 'third-canteen',
  ]);
  assert.ok(catalog.foods.length > 20);
  assert.ok(catalog.reviews.length >= 8);
  assert.equal(catalog.restaurants.find((venue) => venue.id === 'flavor-restaurant').parentId, 'second-canteen');
  assert.equal(catalog.restaurants.find((venue) => venue.id === 'mixue-second-canteen').parentId, 'second-canteen');
  assert.ok(catalog.restaurants.every((venue) => venue.schemaVersion === 2));
  assert.ok(catalog.foods.every((food) => food.schemaVersion === 2));
  assert.ok(catalog.reviews.every((review) => review.schemaVersion === 2));
});

test('migration keeps explicit provenance and changes coordinates to latitude first', () => {
  const first = catalog.restaurants.find((venue) => venue.id === 'first-canteen');
  assert.deepEqual(first.location.coordinates, [30.8826037, 121.8934382]);
  assert.ok(first.sources.length >= 2);
  assert.match(first.description, /酸菜鱼/);
  assert.equal(catalog.foods.some((food) => food.name === '酸菜鱼'), false);
  assert.ok(catalog.reviews.some((review) => review.text.includes('酸菜鱼')));
});

test('public snapshot derives no distance tags from unknown campus distances', () => {
  const snapshot = generateCatalogSnapshot(rawCatalog);
  assert.ok(snapshot.restaurants.every((venue) => !venue.tags.some((tag) => tag.startsWith('within-'))));
  assert.ok(snapshot.restaurants.every((venue) => venue.images.every((image) => image.permission === 'approved')));
});
