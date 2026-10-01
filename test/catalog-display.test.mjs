import test from 'node:test';
import assert from 'node:assert/strict';
import { safePublicImage } from '../src/utils/catalog-display.ts';

const approved = {
  url: 'https://cdn.example.test/review.webp',
  alt: '评价图片',
  sourceUrl: 'https://commons.wikimedia.org/wiki/File:Review.webp',
  sourceNote: '来源与处理说明',
  author: '图片作者',
  license: 'CC BY 4.0',
  permission: 'approved',
  isIllustrative: false,
};

test('safePublicImage keeps approved provenance, hides pending images, and rejects dangerous image URLs', () => {
  assert.deepEqual(safePublicImage(approved), {
    url: approved.url,
    alt: approved.alt,
    sourceUrl: approved.sourceUrl,
    sourceNote: approved.sourceNote,
    author: approved.author,
    license: approved.license,
    isIllustrative: false,
    width: null,
    height: null,
  });
  assert.equal(safePublicImage({ ...approved, permission: 'pending' }), null);
  for (const url of ['javascript:alert(1)', 'http://example.test/review.webp', 'https://user:pass@example.test/review.webp', 'https://localhost/review.webp']) {
    assert.equal(safePublicImage({ ...approved, url }), null, url);
  }
});
