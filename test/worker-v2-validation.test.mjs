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
});
