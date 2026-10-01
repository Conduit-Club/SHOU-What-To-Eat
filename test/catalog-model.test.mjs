import test from 'node:test';
import assert from 'node:assert/strict';
import {
  deriveDistanceTags,
  foodSchema,
  imageSchema,
  loadCatalog,
  reviewSchema,
  validateCatalog,
  venueSchema,
  generateCatalogSnapshot,
  generateSeedSql,
} from '../src/lib/catalog/index.ts';

const source = { repository: 'test', path: 'fixture.md', revision: 'test', license: null, note: null };
const emptyLocation = { address: '测试地址', campusArea: null, floor: null, landmark: null, coordinates: null, distanceMeters: null, distanceBasis: null };
const venue = (id, parentId = null) => ({
  schemaVersion: 2, id, name: id, kind: 'restaurant', parentId, category: 'on-campus', aliases: [], tags: [], location: emptyLocation,
  averagePrice: null, description: null, openingHours: null, foods: [], images: [], sources: [source], dates: { visitedAt: null, verifiedAt: null, updatedAt: null },
});
const food = (id, venueId) => ({
  schemaVersion: 2, id, name: id, venueId, mealTypes: ['meal'], price: null, tags: [], description: null, images: [], sources: [source], dates: { visitedAt: null, verifiedAt: null, updatedAt: null },
});
const review = (id, targetId = 'venue-a') => ({
  schemaVersion: 2, id, targetType: 'venue', targetId, rating: null, text: '可供参考的体验。', images: [], authorAlias: null, visitedAt: null, verifiedAt: null, updatedAt: null, sources: [source],
});
const throwsIssueAt = (callback, path) => assert.throws(callback, (error) => error?.issues?.some((issue) => issue.path.join('.') === path));
const throwsIssueIn = (callback, section) => assert.throws(callback, (error) => error?.issues?.some((issue) => issue.path[0] === section));

test('rejects missing food/review foreign keys and parent cycles', () => {
  assert.throws(() => loadCatalog({ restaurants: [venue('venue-a')], foods: [food('food-a', 'missing')], reviews: [] }), /missing venue/);
  assert.throws(() => loadCatalog({ restaurants: [venue('venue-a')], foods: [], reviews: [review('review-a', 'missing')] }), /missing venue/);
  const cyclicA = venue('venue-a', 'venue-b');
  const cyclicB = venue('venue-b', 'venue-a');
  assert.throws(() => loadCatalog({ restaurants: [cyclicA, cyclicB], foods: [], reviews: [] }), /parent cycle/);
});

test('rejects invalid rating, price range, coordinates and image authorization URL', () => {
  throwsIssueAt(() => reviewSchema.parse({ ...review('review-a'), rating: 6 }), 'rating');
  assert.deepEqual(reviewSchema.parse({ ...review('review-a'), rating: 5, text: '' }).text, '');
  throwsIssueAt(() => reviewSchema.parse({ ...review('review-a'), rating: null, text: '' }), 'text');
  const incompletePrice = { amountCents: null, minCents: 900, currency: 'CNY', unit: '份', source: 'test', verifiedAt: null };
  throwsIssueIn(() => foodSchema.parse({ ...food('food-a', 'venue-a'), price: incompletePrice }), 'price');
  assert.throws(() => venueSchema.parse({ ...venue('venue-a'), location: { ...emptyLocation, coordinates: [91, 181] } }));
  assert.throws(() => venueSchema.parse({ ...venue('venue-a'), category: 'off-campus', location: { ...emptyLocation, distanceMeters: 500 } }));
  assert.throws(() => venueSchema.parse({ ...venue('venue-a'), dates: { visitedAt: null, verifiedAt: null, updatedAt: '2026-02-31' } }));
  assert.throws(() => venueSchema.parse({ ...venue('venue-a'), extra: true }));
  assert.throws(() => imageSchema.parse({ url: 'http://example.test/photo.jpg', alt: '示意图', sourceUrl: null, author: null, license: 'CC BY', permission: 'approved', isIllustrative: true }));
  assert.throws(() => imageSchema.parse({ url: 'https://example.test/photo.jpg', alt: '示意图', sourceUrl: null, author: null, license: null, permission: 'approved', isIllustrative: true }));
});

test('preserves an image source note and enforces its bound', () => {
  const ownPhoto = imageSchema.parse({
    url: 'https://cdn.example.test/photo.webp',
    alt: '酸菜鱼示意图',
    sourceUrl: 'https://files.example.test/original.jpg',
    sourceNote: '本人拍摄；由本站转码 WebP',
    author: '投稿同学',
    license: '本人授权发布',
    permission: 'approved',
    isIllustrative: false,
  });
  assert.equal(ownPhoto.sourceNote, '本人拍摄；由本站转码 WebP');
  assert.equal(imageSchema.parse({ ...ownPhoto, sourceNote: null }).sourceNote, null);
  assert.throws(() => imageSchema.parse({ ...ownPhoto, sourceNote: 'x'.repeat(501) }));
});

test('enforces review Unicode code point limit and strips pending images from public snapshot', () => {
  assert.throws(() => reviewSchema.parse({ ...review('review-a'), text: '界'.repeat(257) }), /256/);
  const pendingImage = { url: 'https://example.test/pending.jpg', alt: '待授权示意图', sourceUrl: 'https://example.test', author: '作者', license: null, permission: 'pending', isIllustrative: true };
  const inputVenue = { ...venue('venue-a'), images: [pendingImage] };
  const pendingOnlyReview = { ...review('review-a'), text: '', images: [pendingImage] };
  const snapshot = generateCatalogSnapshot({ restaurants: [inputVenue], foods: [], reviews: [pendingOnlyReview] });
  assert.deepEqual(snapshot.restaurants[0].images, []);
  assert.deepEqual(snapshot.reviews, []);
});

test('distance tags are cumulative only for explicit off-campus distances', () => {
  const base = { tags: [], location: { ...emptyLocation, distanceMeters: 1800, distanceBasis: 'walking' } };
  assert.deepEqual(deriveDistanceTags({ category: 'off-campus', ...base }), ['within-2km']);
  assert.deepEqual(deriveDistanceTags({ category: 'off-campus', tags: ['within-500m'], location: emptyLocation }), []);
  assert.deepEqual(deriveDistanceTags({ category: 'on-campus', ...base }), []);
});

test('rejects an unlisted food even when its venue foreign key exists', () => {
  assert.throws(() => validateCatalog({ schemaVersion: 2, restaurants: [venue('venue-a')], foods: [food('food-a', 'venue-a')], reviews: [] }), /not listed by its venue/);
});

test('generates a D1 mirror seed with a content-addressed snapshot', async () => {
  const parent = { ...venue('venue-a'), foods: ['food-a'] };
  const sql = await generateSeedSql({ restaurants: [parent], foods: [food('food-a', 'venue-a')], reviews: [] });
  assert.match(sql, /catalog_snapshots/);
  assert.match(sql, /catalog_mirror/);
  assert.match(sql, /catalog-v2-[0-9a-f]{16}/);
  assert.doesNotMatch(sql, /catalog_venues/);
});
