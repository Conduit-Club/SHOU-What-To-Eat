import test from 'node:test';
import assert from 'node:assert/strict';
import { publishMediaAssets, readLimitedBody, validateImageMetadata, validateWebp } from '../src/worker/media.ts';

function webp({ animated = false, chunk = 'VP8X' } = {}) {
  const payload = chunk === 'VP8X' ? Uint8Array.from([animated ? 2 : 0, 0, 0, 0, 1, 0, 0, 1, 0, 0]) : Uint8Array.from([0x2f, 0, 0, 0, 0]);
  const size = payload.length;
  const out = new Uint8Array(12 + 8 + size + (size % 2));
  out.set(new TextEncoder().encode('RIFF'), 0); new DataView(out.buffer).setUint32(4, out.length - 8, true); out.set(new TextEncoder().encode('WEBP'), 8); out.set(new TextEncoder().encode(chunk), 12); new DataView(out.buffer).setUint32(16, size, true); out.set(payload, 20);
  return out;
}

test('WebP validator rejects animation and metadata chunks and reports dimensions', () => {
  assert.deepEqual(validateWebp(webp()), { width: 2, height: 2 });
  assert.throws(() => validateWebp(webp({ animated: true })), /animated_webp/);
  const bad = webp(); bad.set(new TextEncoder().encode('XMP '), 12); assert.throws(() => validateWebp(bad), /unsupported_webp_metadata/);
});

test('image metadata requires rights and preserves permission state', () => {
  const headers = new Headers({ 'X-Image-Alt': 'canteen', 'X-Image-Source': 'https://example.com/photo', 'X-Image-Copyright-Holder': 'submitter', 'X-Image-License': 'self', 'X-Image-Permission': 'pending', 'X-Image-Rights-Confirmed': 'true', 'X-Image-Is-Illustrative': 'false' });
  assert.equal(validateImageMetadata(headers).permission, 'pending');
  assert.match(validateImageMetadata(headers).sourceNote, /https:\/\/example\.com\/photo；已转码WebP/);
  headers.set('X-Image-Source', 'http://example.com/photo');
  assert.equal(validateImageMetadata(headers), null);
  headers.set('X-Image-Source', 'https://example.com/photo');
  headers.set('X-Image-Permission', 'approved'); assert.equal(validateImageMetadata(headers), null);
  headers.set('X-Image-Permission', 'pending');
  headers.set('X-Image-Rights-Confirmed', 'false'); assert.equal(validateImageMetadata(headers), null);
});

test('decodes percent encoded UTF-8 image metadata once and rejects malformed input', () => {
  const headers = new Headers({
    'X-Image-Alt': encodeURIComponent('酸菜鱼 😀'),
    'X-Image-Source': encodeURIComponent('本人拍摄'),
    'X-Image-Copyright-Holder': encodeURIComponent('投稿同学'),
    'X-Image-License': encodeURIComponent('本人授权发布'),
    'X-Image-Rights-Confirmed': 'true',
    'X-Image-Is-Illustrative': 'true',
    'X-Image-Metadata-Encoding': 'percent-utf8',
  });
  assert.equal(validateImageMetadata(headers).alt, '酸菜鱼 😀');
  headers.set('X-Image-Alt', '%E0%A4%A');
  assert.equal(validateImageMetadata(headers), null);
});

test('streamed image body stops before retaining bytes over the limit', async () => {
  const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(5)); controller.enqueue(new Uint8Array(5)); controller.close(); } });
  const result = await readLimitedBody(new Request('https://example.com', { method: 'POST', body, duplex: 'half' }), 6);
  assert.equal(result.tooLarge, true);
  assert.equal(result.bytes, null);
});

test('R2 group promotion compensates an earlier public object when a later PUT fails', async () => {
  const objects = new Map([
    ['media/asset-one.webp', { bytes: Uint8Array.of(1), customMetadata: { assetId: 'asset-one', visibility: 'private' } }],
    ['media/asset-two.webp', { bytes: Uint8Array.of(2), customMetadata: { assetId: 'asset-two', visibility: 'private' } }],
  ]);
  let publicPuts = 0;
  const bucket = {
    async get(key) {
      const value = objects.get(key);
      if (!value) return null;
      return { customMetadata: { ...value.customMetadata }, async arrayBuffer() { return value.bytes.slice().buffer; } };
    },
    async put(key, body, options) {
      const visibility = options.customMetadata.visibility;
      if (visibility === 'published' && ++publicPuts === 2) throw new Error('simulated_r2_failure');
      objects.set(key, { bytes: new Uint8Array(body), customMetadata: { ...options.customMetadata } });
    },
  };
  const db = { prepare() { return { bind() { return { async run() { return { meta: { changes: 1 } }; } }; } }; } };
  await assert.rejects(() => publishMediaAssets({ MEDIA_MODE: 'r2', IMAGES: bucket, DB: db }, ['asset-one', 'asset-two']), /simulated_r2_failure/);
  assert.equal(objects.get('media/asset-one.webp').customMetadata.visibility, 'private');
  assert.equal(objects.get('media/asset-two.webp').customMetadata.visibility, 'private');
});
