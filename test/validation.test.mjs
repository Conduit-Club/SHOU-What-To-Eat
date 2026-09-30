import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSubmission } from '../src/worker/validation.ts';

const valid = { kind: 'review', targetId: 'first-canteen', name: '一食堂', location: '一楼窗口', body: '牛肉面好吃', category: 'on-campus' };

test('accepts a bounded restaurant contribution', () => {
  assert.equal(validateSubmission(valid).type, 'review');
});

test('rejects invalid category and oversized text', () => {
  assert.throws(() => validateSubmission({ ...valid, category: 'unknown' }), /invalid_category_or_kind/);
  assert.throws(() => validateSubmission({ ...valid, body: 'x'.repeat(20_001) }), /content_too_long/);
});

test('rejects future dates and non-HTTPS image destinations', () => {
  assert.throws(() => validateSubmission({ ...valid, visitedAt: '2999-01-01' }), /invalid_visited_at/);
  assert.throws(() => validateSubmission({ ...valid, visitedAt: '2026-02-31' }), /invalid_visited_at/);
  assert.throws(() => validateSubmission({ ...valid, imageUrl: 'http://example.com/a.jpg' }), /invalid_image_url/);
});

test('requires core text fields', () => {
  assert.throws(() => validateSubmission({ ...valid, name: '' }), /invalid_name/);
});
