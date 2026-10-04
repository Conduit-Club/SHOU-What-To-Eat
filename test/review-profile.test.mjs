import test from 'node:test';
import assert from 'node:assert/strict';
import { diningDate } from '../src/utils/dining-date.ts';
import { publicAvatar, reviewIdentity, initReviewAvatars } from '../src/utils/review-identity.ts';
import { updatePublicationIdentity } from '../src/utils/publication-identity.ts';
import { reviewAuthor } from '../src/worker/live-detail.ts';
import { reviewSchema } from '../src/lib/catalog/index.ts';
import { canonicalReview } from '../src/worker/publication/github.ts';
import { validateManagedEdit } from '../src/lib/catalog/management.ts';
import { validateV2Submission } from '../src/worker/v2-validation.ts';

const picture = 'https://auth.shoumc.com/api/profile/avatar/' + 'a'.repeat(64) + '.png';
const source = { repository: 'local', path: 'fixture', revision: 'test', license: null };
const review = { schemaVersion: 2, id: 'review-a', targetType: 'food', targetId: 'food-a', rating: 4, text: '', images: [], authorAlias: '海大学生', authorAvatar: picture, visitedAt: '2026-10-01', verifiedAt: null, updatedAt: null, sources: [source] };

test('dining dates consistently follow UTC+8 midnight and leap days', () => {
  for (const [timestamp, expected] of [['2026-10-04T15:59:59.999Z', '2026-10-04'], ['2026-10-04T16:00:00.000Z', '2026-10-05'], ['2024-02-28T16:00:00.000Z', '2024-02-29'], ['2026-12-31T16:00:00.000Z', '2027-01-01']]) assert.equal(diningDate(Date.parse(timestamp)), expected);
});

test('public author markup escapes names and anonymous identities never render an avatar', async () => {
  assert.equal(publicAvatar(picture), picture);
  for (const value of [picture + '?tracking=1', picture + '#fragment', picture.replace('auth.shoumc.com', 'evil.test'), picture.replace('https:', 'http:'), picture.replace('.png', '.svg'), picture.replace('/avatar/', '/avatar/%2e%2e/'), picture.replace('https://', 'https://user:pass@')]) assert.equal(publicAvatar(value), null);
  assert.deepEqual(reviewIdentity({ authorAlias: null, authorAvatar: picture }), { name: '匿名同学', picture: null, initial: '匿' });
  const anonymous = String(await reviewAuthor({ authorAlias: null, authorAvatar: picture }));
  assert.doesNotMatch(anonymous, /<img|auth\.shoumc|avatar\//);
  const named = String(await reviewAuthor({ authorAlias: '<img onerror=evil>', authorAvatar: picture }));
  assert.match(named, /&lt;img onerror=evil&gt;/);
  assert.match(named, /data-review-avatar/);
  assert.match(named, /referrerpolicy="no-referrer"/);
  assert.doesNotMatch(named, /<img onerror/);
});

test('legacy reviews preserve unknown dates and new public snapshots remain immutable', () => {
  const old = { ...review }; delete old.authorAvatar; old.visitedAt = null;
  const legacy = reviewSchema.parse(old);
  assert.equal(legacy.visitedAt, null); assert.equal(legacy.authorAvatar, undefined);
  assert.equal(canonicalReview({ ...old, authorAlias: null, authorAvatar: picture }, 'old-review', [], [source]).authorAvatar, null);
  assert.throws(() => reviewSchema.parse({ ...review, authorAlias: null }));
  assert.throws(() => reviewSchema.parse({ ...review, authorAvatar: 'https://evil.test/avatar.png' }));
  for (const change of [{ authorAvatar: null }, { visitedAt: null }, { authorAlias: '伪造署名' }]) assert.throws(() => validateManagedEdit('review', review, { ...review, ...change }), /review_content_immutable/);
});

test('clients cannot submit an avatar, identity ID or arbitrary public snapshot through either review form', () => {
  const envelope = { schemaVersion: 2, snapshotId: 'current', expectedImages: 0, expectedReviewImages: 0, turnstileToken: 'test-token', entityType: 'review', payload: { targetType: 'food', targetId: 'food-a', rating: 4, text: '' } };
  for (const injected of [{ authorAvatar: picture }, { userId: 1 }, { subject: 'private' }]) {
    assert.throws(() => validateV2Submission({ ...envelope, payload: { ...envelope.payload, ...injected } }), error => error.code === 'unknown_fields');
    assert.throws(() => validateV2Submission({ ...envelope, entityType: 'food', payload: { name: '餐品', venueId: 'venue-a', attachedReview: { rating: 4, ...injected } } }), error => error.code === 'unknown_fields');
  }
});

test('shared privacy selector enables both forms for signed-in users and invalid avatars fall back', () => {
  const choice = { disabled: true, checked: false, dataset: {} }, label = {}, image = { hidden: true, removeAttribute(name) { delete this[name]; } }, initial = {}, note = {};
  const nodes = { '[data-username-choice]': choice, '[data-username-label]': label, '[data-identity-avatar]': image, '[data-identity-initial]': initial, '[data-identity-note]': note };
  const root = { querySelector: selector => nodes[selector] };
  const update = updatePublicationIdentity(root, { username: '海大学生', picture });
  assert.equal(choice.disabled, false); assert.equal(choice.checked, false); assert.equal(image.src, picture);
  assert.match(note.textContent, /不公开账号用户名或头像/);
  choice.checked = true; update(); assert.match(note.textContent, /海大学生/);
  updatePublicationIdentity(root, { username: '海大学生', picture: 'https://evil.test/avatar.png' }); assert.equal(image.hidden, true); assert.equal(image.src, undefined);
  updatePublicationIdentity(root, null); assert.equal(choice.disabled, true); assert.match(note.textContent, /请先登录/);
  assert.equal(initial.textContent, '我');
});

test('deleted and already-failed avatars retain a text fallback without a broken image', () => {
  let onerror;
  const image = { hidden: false, src: picture, complete: false, naturalWidth: 0, getAttribute() { return this.src; }, removeAttribute() { delete this.src; }, addEventListener(type, fn) { if (type === 'error') onerror = fn; } };
  initReviewAvatars({ querySelectorAll: () => [image] }); assert.equal(image.hidden, false);
  onerror(); assert.equal(image.hidden, true); assert.equal(image.src, undefined);
  image.src = picture; image.hidden = false; image.complete = true;
  initReviewAvatars({ querySelectorAll: () => [image] }); assert.equal(image.hidden, true);
});
