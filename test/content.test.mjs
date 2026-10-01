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

const migrationSources = [
  { repository: 'what-to-eat-in-shou-today', path: 'website/docs/on-campus/first-canteen.md', revision: 'working-tree' },
  { repository: 'what-to-eat-in-shou-contributions', path: 'data/reviewed/canteen-windows-2026-09.json', revision: 'working-tree' },
  { repository: 'SHOU-Online-Manual', path: 'docs/canteen/campus-dining.md', revision: 'working-tree' },
];

function hasMigrationSource(record) {
  return record.sources.some((source) => migrationSources.some((candidate) => candidate.repository === source.repository && candidate.path === source.path && candidate.revision === source.revision));
}

test('migrated content has stable IDs and valid relationships', () => {
  const migratedVenues = catalog.restaurants.filter(hasMigrationSource);
  assert.deepEqual(migratedVenues.map((venue) => venue.id).sort(), [
    'area-a-711', 'area-b-711', 'first-canteen', 'flavor-restaurant', 'mixue-second-canteen', 'second-canteen', 'third-canteen',
  ]);
  assert.equal(migratedVenues.length, 7);
  assert.ok(catalog.foods.length > 20);
  assert.ok(catalog.reviews.length >= 8);
  assert.equal(catalog.restaurants.find((venue) => venue.id === 'flavor-restaurant').parentId, 'second-canteen');
  assert.equal(catalog.restaurants.find((venue) => venue.id === 'mixue-second-canteen').parentId, 'second-canteen');
  assert.ok(catalog.restaurants.every((venue) => venue.schemaVersion === 2));
  assert.ok(catalog.foods.every((food) => food.schemaVersion === 2));
  assert.ok(catalog.reviews.every((review) => review.schemaVersion === 2));
});

test('migration keeps explicit provenance and changes coordinates to latitude first', () => {
  const first = catalog.restaurants.find((venue) => venue.id === 'first-canteen' && hasMigrationSource(venue));
  assert.deepEqual(first.location.coordinates, [30.8826037, 121.8934382]);
  assert.deepEqual(catalog.restaurants.find((venue) => venue.id === 'second-canteen' && hasMigrationSource(venue)).location.coordinates, [30.8826095, 121.8912025]);
  assert.deepEqual(catalog.restaurants.find((venue) => venue.id === 'third-canteen' && hasMigrationSource(venue)).location.coordinates, [30.8893715, 121.8918594]);
  assert.ok(first.sources.length >= 2);
  assert.match(first.description, /酸菜鱼/);
  const migratedFoods = catalog.foods.filter(hasMigrationSource);
  assert.equal(migratedFoods.some((food) => food.name === '酸菜鱼'), false);
  const acidFishReview = catalog.reviews.find((review) => review.id === 'first-canteen-review-c-2' && hasMigrationSource(review));
  assert.equal(acidFishReview.text, '一餐二楼的酸菜鱼是现煮的，油一泼上去特别香，就是有花椒会有点呛，略微小贵，19 块，但是肯定是值得的。');
  assert.ok(acidFishReview.text.includes('酸菜鱼'));
});

test('public snapshot derives no distance tags from unknown campus distances', () => {
  const snapshot = generateCatalogSnapshot(rawCatalog);
  const unknownCampusVenues = catalog.restaurants.filter((venue) => venue.category === 'on-campus' && venue.location.distanceMeters === null && venue.location.distanceBasis === null);
  assert.ok(unknownCampusVenues.length > 0);
  for (const venue of unknownCampusVenues) assert.ok(!snapshot.restaurants.find((item) => item.id === venue.id).tags.some((tag) => tag.startsWith('within-')));
  const publicRecords = [...snapshot.restaurants, ...snapshot.foods, ...snapshot.reviews];
  assert.ok(publicRecords.every((record) => record.images.every((image) => image.permission === 'approved')));
});

test('new contribution may add an acid-fish food and an evidence-based off-campus distance', () => {
  const contributionSource = { repository: 'integration-contribution', path: 'submissions/sour-fish.json', revision: 'test', license: null };
  const venueId = 'nearby-sour-fish-stall';
  const foodId = 'nearby-sour-fish';
  const contributedVenue = {
    schemaVersion: 2,
    id: venueId,
    name: '校外酸菜鱼档口',
    kind: 'stall',
    parentId: null,
    category: 'off-campus',
    aliases: [],
    tags: ['contribution'],
    location: { address: '学校外步行路线上的实测点位', campusArea: null, floor: null, landmark: null, coordinates: null, distanceMeters: 800, distanceBasis: 'walking' },
    averagePrice: null,
    description: '投稿 fixture：距离与依据均由实测声明提供。',
    openingHours: null,
    foods: [foodId],
    images: [],
    sources: [contributionSource],
    dates: { visitedAt: null, verifiedAt: null, updatedAt: null },
  };
  const contributedFood = {
    schemaVersion: 2,
    id: foodId,
    name: '酸菜鱼',
    venueId,
    mealTypes: ['meal'],
    price: { amountCents: 1900, minCents: null, maxCents: null, currency: 'CNY', unit: '份', source: '投稿实测价格', verifiedAt: null },
    tags: [],
    description: '投稿 fixture 菜品。',
    images: [],
    sources: [contributionSource],
    dates: { visitedAt: null, verifiedAt: null, updatedAt: null },
  };
  const contributedReview = {
    schemaVersion: 2,
    id: 'nearby-sour-fish-review',
    targetType: 'food',
    targetId: foodId,
    rating: 5,
    text: '',
    images: [],
    authorAlias: '投稿同学',
    visitedAt: null,
    verifiedAt: null,
    updatedAt: null,
    sources: [contributionSource],
  };
  const contributed = loadCatalog({
    restaurants: [...rawCatalog.restaurants, contributedVenue],
    foods: [...rawCatalog.foods, contributedFood],
    reviews: [...rawCatalog.reviews, contributedReview],
  });
  assert.deepEqual(contributed.restaurants.filter(hasMigrationSource).map((venue) => venue.id).sort(), [
    'area-a-711', 'area-b-711', 'first-canteen', 'flavor-restaurant', 'mixue-second-canteen', 'second-canteen', 'third-canteen',
  ]);
  assert.equal(contributed.foods.filter(hasMigrationSource).some((food) => food.name === '酸菜鱼'), false);
  const snapshot = generateCatalogSnapshot(contributed);
  assert.equal(snapshot.foods.find((food) => food.id === foodId).name, '酸菜鱼');
  assert.ok(snapshot.restaurants.find((venue) => venue.id === venueId).tags.includes('within-1km'));
  assert.ok(snapshot.reviews.some((review) => review.id === 'nearby-sour-fish-review'));
  assert.equal(snapshot.restaurants.find((venue) => venue.id === 'first-canteen').description.includes('酸菜鱼'), true);
});
