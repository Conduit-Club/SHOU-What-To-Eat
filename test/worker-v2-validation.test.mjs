import test from 'node:test';
import assert from 'node:assert/strict';
import { validateV2Submission, V2ValidationError, isCalendarDate } from '../src/worker/v2-validation.ts';

const baseVenue = {
  schemaVersion: 2,
  entityType: 'venue',
  snapshotId: 'catalog-v2-test',
  expectedImages: 0,
  expectedReviewImages: 0,
  turnstileToken: 'test-token',
  payload: {
    name: '测试食堂', kind: 'cafeteria', category: 'on-campus',
    location: { address: '校园内', coordinates: [30.88, 121.89] },
    averagePrice: { minCents: 1000, maxCents: 1800, currency: 'CNY', unit: '人', source: '现场菜单', verifiedAt: null },
  },
};

const baseFood = {
  schemaVersion: 2,
  entityType: 'food',
  snapshotId: 'catalog-v2-test',
  expectedImages: 1,
  expectedReviewImages: 0,
  turnstileToken: 'test-token',
  payload: {
    name: '测试餐品', venueId: 'venue-1', mealType: 'meal', description: null,
    price: null, tags: [],
  },
};

test('v2 accepts canonical latitude-first coordinates and rating-only attached reviews', () => {
  const value = validateV2Submission({ ...baseVenue, payload: { ...baseVenue.payload, attachedReview: { rating: 5 } } });
  assert.deepEqual(value.publicJson.payload.attachedReview, { rating: 5, text: '' });
  assert.deepEqual(value.publicJson.payload.location.coordinates, [30.88, 121.89]);
  assert.equal(value.expectedReviewImages, 0);
  const withImage = validateV2Submission({ ...baseVenue, expectedReviewImages: 1, payload: { ...baseVenue.payload, attachedReview: { rating: 5 } } });
  assert.equal(withImage.expectedReviewImages, 1);
});

test('v2 rejects non-integer or missing ratings and Unicode text over 256 code points', () => {
  for (const rating of [0, 6, 2.5, null]) {
    assert.throws(() => validateV2Submission({ ...baseVenue, entityType: 'review', expectedImages: 0, payload: { targetType: 'venue', targetId: 'venue-1', rating, text: '' } }), V2ValidationError);
  }
  assert.throws(() => validateV2Submission({ ...baseVenue, expectedImages: 0, payload: { ...baseVenue.payload, attachedReview: { rating: 4, text: '😀'.repeat(257) } } }), V2ValidationError);
});

test('v2 keeps attached review image count separate and validates source provenance', () => {
  assert.throws(() => validateV2Submission({ ...baseVenue, expectedReviewImages: 1 }), V2ValidationError);
  assert.throws(() => validateV2Submission({ ...baseVenue, payload: { ...baseVenue.payload, sources: [{ repository: 'x', path: 'x', revision: 'x', sourceUrl: 'http://insecure.example' }] } }), V2ValidationError);
  const result = validateV2Submission({ ...baseVenue, payload: { ...baseVenue.payload, sources: [{ repository: 'x', path: 'x', revision: 'x', sourceUrl: 'https://example.com/source' }] } });
  assert.equal(result.publicJson.payload.sources[0].sourceUrl, 'https://example.com/source');
});

test('v2 date validation rejects impossible calendar dates', () => {
  assert.equal(isCalendarDate('2024-02-29'), true);
  assert.equal(isCalendarDate('2026-02-29'), false);
  assert.equal(isCalendarDate('2026-04-31'), false);
  assert.throws(() => validateV2Submission({ ...baseVenue, payload: { ...baseVenue.payload, verifiedAt: '2026-02-31' } }), V2ValidationError);
  for (const visitedAt of ['9999-12-31', '2026-02-31']) {
    assert.throws(() => validateV2Submission({ ...baseVenue, entityType: 'review', payload: { targetType: 'venue', targetId: 'venue-1', rating: 4, visitedAt } }), V2ValidationError);
    assert.throws(() => validateV2Submission({ ...baseVenue, payload: { ...baseVenue.payload, attachedReview: { rating: 4, visitedAt } } }), V2ValidationError);
  }
  const result = validateV2Submission({ ...baseVenue, payload: { ...baseVenue.payload, attachedReview: { rating: 4, visitedAt: '2024-02-29' } } });
  assert.equal(result.attachedReview.visitedAt, '2024-02-29');
});

test('v2 validates venue auxiliary field lengths and canonical distance pairs', () => {
  const valid = validateV2Submission({
    ...baseVenue,
    payload: {
      ...baseVenue.payload,
      description: '营业情况待补充',
      category: 'off-campus',
      openingHours: '工作日 10:00-20:00',
      location: {
        ...baseVenue.payload.location,
        campusArea: '东区', floor: '二楼', landmark: '图书馆旁',
        distanceMeters: 800, distanceBasis: 'walking',
      },
    },
  });
  assert.equal(valid.publicJson.payload.location.distanceMeters, 800);
  assert.equal(valid.publicJson.payload.location.distanceBasis, 'walking');
  assert.doesNotThrow(() => validateV2Submission({
    ...baseVenue,
    payload: {
      ...baseVenue.payload,
      description: null,
      openingHours: null,
      location: { ...baseVenue.payload.location, campusArea: null, floor: null, landmark: null, distanceMeters: null, distanceBasis: null },
    },
  }));

  const overlong = [
    ['description', 'x'.repeat(2001), 'invalid_description'],
    ['openingHours', 'x'.repeat(301), 'invalid_opening_hours'],
    ['campusArea', 'x'.repeat(101), 'invalid_campus_area'],
    ['floor', 'x'.repeat(101), 'invalid_floor'],
    ['landmark', 'x'.repeat(161), 'invalid_landmark'],
  ];
  for (const [field, value, code] of overlong) {
    const payload = field === 'campusArea' || field === 'floor' || field === 'landmark'
      ? { ...baseVenue.payload, location: { ...baseVenue.payload.location, [field]: value } }
      : { ...baseVenue.payload, [field]: value };
    assert.throws(() => validateV2Submission({ ...baseVenue, payload }), (error) => error instanceof V2ValidationError && error.code === code, field);
  }

  for (const [payload, code] of [
    [{ ...baseVenue.payload, location: { ...baseVenue.payload.location, distanceMeters: 800 } }, 'invalid_distance'],
    [{ ...baseVenue.payload, location: { ...baseVenue.payload.location, distanceBasis: 'walking' } }, 'invalid_distance'],
    [{ ...baseVenue.payload, location: { ...baseVenue.payload.location, distanceMeters: -1, distanceBasis: 'walking' } }, 'invalid_distance'],
    [{ ...baseVenue.payload, location: { ...baseVenue.payload.location, distanceMeters: 800.5, distanceBasis: 'walking' } }, 'invalid_distance'],
    [{ ...baseVenue.payload, location: { ...baseVenue.payload.location, distanceMeters: 800, distanceBasis: 'driving' } }, 'invalid_distance_basis'],
  ]) assert.throws(() => validateV2Submission({ ...baseVenue, payload }), (error) => error instanceof V2ValidationError && error.code === code);
});

test('v2 accepts only the shared meal type vocabulary for singular and plural fields', () => {
  for (const mealType of ['breakfast', 'meal', 'snack', 'dessert', 'drink']) {
    assert.doesNotThrow(() => validateV2Submission({ ...baseFood, payload: { ...baseFood.payload, mealType } }));
  }
  assert.doesNotThrow(() => validateV2Submission({ ...baseFood, payload: { ...baseFood.payload, mealType: null, mealTypes: ['meal', 'snack'] } }));
  for (const payload of [
    { ...baseFood.payload, mealType: 'brunch' },
    { ...baseFood.payload, mealType: 'x'.repeat(81) },
    { ...baseFood.payload, mealTypes: ['meal', 'brunch'] },
    { ...baseFood.payload, mealTypes: ['meal', 'meal'] },
  ]) assert.throws(() => validateV2Submission({ ...baseFood, payload }), (error) => error instanceof V2ValidationError && error.code === 'invalid_meal_type');
});
