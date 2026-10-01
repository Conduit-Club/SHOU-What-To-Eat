import type { AppEnv } from './types.js';

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export const MAX_IMAGE_WIDTH = 4096;
export const MAX_IMAGE_HEIGHT = 4096;
export const MAX_IMAGE_PIXELS = 16_000_000;
export const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
export const MAX_MONTHLY_MEDIA_PUTS = 1_000;
export const MAX_DAILY_MEDIA_ATTEMPTS = 100;

export type ImageSlot = 'entity' | 'attachedReview';
export type ImageMetadata = {
  alt: string;
  source: string;
  sourceNote: string;
  copyrightHolder: string;
  license: string;
  permission: 'pending' | 'approved';
  rightsConfirmed: boolean;
  isIllustrative: boolean;
  coverAllowed?: boolean;
};
export type WebpInfo = { width: number; height: number };

export async function readLimitedBody(request: Request, maxBytes = MAX_IMAGE_BYTES): Promise<{ bytes: Uint8Array | null; tooLarge: boolean }> {
  if (!request.body) return { bytes: null, tooLarge: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        return { bytes: null, tooLarge: true };
      }
      chunks.push(next.value);
    }
  } catch {
    return { bytes: null, tooLarge: false };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, tooLarge: false };
}

export function validateImageMetadata(headers: Headers): ImageMetadata | null {
  const encoding = headers.get('X-Image-Metadata-Encoding')?.trim() ?? '';
  if (encoding && encoding !== 'percent-utf8') return null;
  const alt = decodeMetadata(headers.get('X-Image-Alt'), encoding);
  const source = decodeMetadata(headers.get('X-Image-Source'), encoding);
  const sourceNoteHeader = headers.get('X-Image-Source-Note');
  const declaredSourceNote = sourceNoteHeader === null ? undefined : decodeMetadata(sourceNoteHeader, encoding);
  const copyrightHolder = decodeMetadata(headers.get('X-Image-Copyright-Holder'), encoding);
  const license = decodeMetadata(headers.get('X-Image-License'), encoding);
  const permissionValue = headers.get('X-Image-Permission')?.trim().toLowerCase() ?? 'pending';
  const rightsConfirmed = headers.get('X-Image-Rights-Confirmed')?.trim().toLowerCase() === 'true';
  const coverValue = headers.get('X-Image-Cover-Allowed');
  if (coverValue !== null && !['true','false'].includes(coverValue)) return null;
  const illustrativeValue = headers.get('X-Image-Is-Illustrative')?.trim().toLowerCase();
  // Approval is an auditor decision. A submitter may only upload a pending
  // asset; the admin approval CAS changes this field after rights review.
  const sourceNote = declaredSourceNote === undefined ? `${source}；已转码WebP` : declaredSourceNote;
  if (!alt || !within(alt, 200) || !source || !within(source, 480) || !sourceNote || !within(sourceNote, 500) || !copyrightHolder || !within(copyrightHolder, 160) || !license || !within(license, 120) || !rightsConfirmed || !['true', 'false'].includes(illustrativeValue ?? '') || permissionValue !== 'pending') return null;
  if (/^https?:\/\//i.test(source)) { try { const url = new URL(source); if (url.protocol !== 'https:' || url.username || url.password) return null; } catch { return null; } }
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(`${alt}${source}${sourceNote}${copyrightHolder}${license}`)) return null;
  return { alt, source, sourceNote, copyrightHolder, license, permission: permissionValue as 'pending' | 'approved', rightsConfirmed, isIllustrative: illustrativeValue === 'true', ...(coverValue === null ? {} : { coverAllowed: coverValue === 'true' }) };
}

function decodeMetadata(value: string | null, encoding: string): string | null {
  if (value === null) return '';
  try { return (encoding === 'percent-utf8' ? decodeURIComponent(value) : value).trim(); } catch { return null; }
}

function within(value: string, maximum: number): boolean { return value.length <= maximum; }

export function validateWebp(bytes: Uint8Array): WebpInfo {
  if (bytes.length < 20 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') throw new Error('invalid_webp');
  const riffSize = readUint32(bytes, 4);
  if (riffSize + 8 !== bytes.length) throw new Error('invalid_webp');
  let offset = 12;
  let dimensions: WebpInfo | null = null;
  while (offset + 8 <= bytes.length) {
    const chunkType = ascii(bytes, offset, 4);
    const chunkSize = readUint32(bytes, offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkSize;
    if (dataEnd > bytes.length) throw new Error('invalid_webp');
    const payload = bytes.subarray(dataStart, dataEnd);
    if (chunkType === 'EXIF' || chunkType === 'XMP ' || chunkType === 'ANIM' || chunkType === 'ANMF') throw new Error('unsupported_webp_metadata');
    if (chunkType === 'VP8X') {
      if (payload.length < 10 || (payload[0] & 0x02) !== 0) throw new Error('animated_webp');
      dimensions = { width: 1 + readUint24(payload, 4), height: 1 + readUint24(payload, 7) };
    } else if (chunkType === 'VP8 ' && payload.length >= 10 && payload[3] === 0x9d && payload[4] === 0x01 && payload[5] === 0x2a) {
      dimensions = { width: readUint16(payload, 6) & 0x3fff, height: readUint16(payload, 8) & 0x3fff };
    } else if (chunkType === 'VP8L' && payload.length >= 5 && payload[0] === 0x2f) {
      const bits = payload[1] + payload[2] * 0x100 + payload[3] * 0x10000 + payload[4] * 0x1000000;
      const width = (bits & 0x3fff) + 1;
      const height = (Math.floor(bits / 0x4000) & 0x3fff) + 1;
      dimensions = { width, height };
    }
    offset = dataEnd + (chunkSize & 1);
  }
  if (offset !== bytes.length || !dimensions || dimensions.width < 1 || dimensions.height < 1 || dimensions.width > MAX_IMAGE_WIDTH || dimensions.height > MAX_IMAGE_HEIGHT || dimensions.width * dimensions.height > MAX_IMAGE_PIXELS) throw new Error('image_dimensions_invalid');
  return dimensions;
}

export function mediaObjectKey(assetId: string): string { return `media/${assetId}.webp`; }

/** Count a client upload attempt. Failed validation/storage attempts are kept. */
export async function reserveMediaAttempt(db: D1Database): Promise<boolean> {
  const day = new Date().toISOString().slice(0, 10);
  const result = await db.prepare("INSERT INTO media_upload_attempts (day_key, attempt_count, max_attempts) VALUES (?, 1, ?) ON CONFLICT (day_key) DO UPDATE SET attempt_count = attempt_count + 1 WHERE attempt_count < max_attempts").bind(day, MAX_DAILY_MEDIA_ATTEMPTS).run();
  return Boolean(result.meta.changes);
}

/** Reserve bytes before the R2 PUT. The reservation is deliberately retained
 * when the subsequent R2 or D1 operation fails, for operator reconciliation. */
export async function reserveMediaPut(db: D1Database, assetId: string, submissionId: string, byteSize: number): Promise<boolean> {
  const now = new Date().toISOString();
  try {
    const result = await db.prepare('INSERT INTO media_reservations (id, asset_id, submission_id, byte_size, state, reason, created_at, updated_at) VALUES (?, ?, ?, ?, \'reserved\', NULL, ?, ?)').bind(crypto.randomUUID(), assetId, submissionId, byteSize, now, now).run();
    return Boolean(result.meta.changes);
  } catch {
    return false;
  }
}

export async function markMediaReservation(db: D1Database, assetId: string, state: 'committed' | 'orphan', reason: string | null): Promise<void> {
  await db.prepare("UPDATE media_reservations SET state = ?, reason = ?, updated_at = ? WHERE asset_id = ? AND state IN ('reserved', 'committed')").bind(state, reason, new Date().toISOString(), assetId).run();
}

/** Publication rewrites do not reserve bytes, but remain bounded by a monthly
 * operation budget so a repeatedly failing callback cannot loop forever. */
export async function reserveMediaOperation(db: D1Database): Promise<boolean> {
  const month = new Date().toISOString().slice(0, 7);
  const result = await db.prepare("INSERT INTO media_operation_quota (month_key, put_count, max_puts) VALUES (?, 1, ?) ON CONFLICT (month_key) DO UPDATE SET put_count = put_count + 1 WHERE put_count < max_puts").bind(month, MAX_MONTHLY_MEDIA_PUTS).run();
  return Boolean(result.meta.changes);
}

export async function putPrivateMedia(env: AppEnv['Bindings'], assetId: string, bytes: Uint8Array, metadata: ImageMetadata, entityType: string, entityId: string, slot: ImageSlot, slotIndex: number): Promise<void> {
  if (env.MEDIA_MODE !== 'r2' || !env.IMAGES) throw new Error('media_storage_unavailable');
  const key = mediaObjectKey(assetId);
  await env.IMAGES.put(key, bytes, {
    httpMetadata: { contentType: 'image/webp', cacheControl: 'private, no-store' },
    customMetadata: { assetId, visibility: 'private', entityType, entityId, slot, slotIndex: String(slotIndex), permission: metadata.permission, sourceNote: metadata.sourceNote },
  });
}

export async function deleteMedia(env: AppEnv['Bindings'], assetId: string): Promise<void> {
  if (env.IMAGES) await env.IMAGES.delete(mediaObjectKey(assetId));
}

export async function sha256Bytes(bytes: Uint8Array): Promise<string> {
  // Workers' DOM typings require an ArrayBuffer-backed view. Copying also
  // prevents a caller's mutable buffer from changing while hashing.
  const stable = new Uint8Array(bytes.byteLength);
  stable.set(bytes);
  const digest = await crypto.subtle.digest('SHA-256', stable.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Publish a group of objects with compensation. R2 and D1 do not share an
 * atomic transaction: all objects are read and checked first, then promoted
 * one by one. If a later PUT fails, already promoted objects are rewritten as
 * private before the error is returned so a retry cannot skip an incomplete
 * submission. The caller keeps the D1 rows private until its own transaction
 * succeeds.
 */
export async function publishMediaAssets(env: AppEnv['Bindings'], assetIds: string[]): Promise<void> {
  if (!assetIds.length) return;
  if (env.MEDIA_MODE !== 'r2' || !env.IMAGES) throw new Error('media_storage_unavailable');
  const uniqueIds = [...new Set(assetIds)];
  const objects: MediaObject[] = [];
  for (const assetId of uniqueIds) {
    const object = await env.IMAGES.get(mediaObjectKey(assetId));
    if (!object || object.customMetadata?.assetId !== assetId || object.customMetadata.visibility !== 'private') throw new Error('media_object_missing');
    objects.push({ assetId, bytes: new Uint8Array(await object.arrayBuffer()), customMetadata: { ...(object.customMetadata ?? {}) } });
  }
  for (const _object of objects) if (!await reserveMediaOperation(env.DB)) throw new Error('media_operation_quota_exceeded');
  const promoted: MediaObject[] = [];
  try {
    for (const object of objects) {
      await env.IMAGES.put(mediaObjectKey(object.assetId), object.bytes, {
        httpMetadata: { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' },
        customMetadata: { ...object.customMetadata, assetId: object.assetId, visibility: 'published' },
      });
      promoted.push(object);
    }
  } catch (error) {
    await restoreMediaObjects(env, promoted);
    throw error;
  }
}

/** Restore visibility after a D1 transaction fails following R2 promotion. */
export async function restorePrivateMedia(env: AppEnv['Bindings'], assetIds: string[]): Promise<void> {
  if (env.MEDIA_MODE !== 'r2' || !env.IMAGES) return;
  const objects: MediaObject[] = [];
  for (const assetId of [...new Set(assetIds)]) {
    const object = await env.IMAGES.get(mediaObjectKey(assetId));
    if (!object || object.customMetadata?.visibility !== 'published') continue;
    objects.push({ assetId, bytes: new Uint8Array(await object.arrayBuffer()), customMetadata: { ...(object.customMetadata ?? {}) } });
  }
  await restoreMediaObjects(env, objects);
}

async function restoreMediaObjects(env: AppEnv['Bindings'], objects: MediaObject[]): Promise<void> {
  if (!env.IMAGES) return;
  await Promise.all(objects.map((object) => env.IMAGES!.put(mediaObjectKey(object.assetId), object.bytes, {
    httpMetadata: { contentType: 'image/webp', cacheControl: 'private, no-store' },
    customMetadata: { ...object.customMetadata, assetId: object.assetId, visibility: 'private' },
  })));
}

export async function markMediaPublished(env: AppEnv['Bindings'], assetId: string): Promise<void> {
  await publishMediaAssets(env, [assetId]);
}

type MediaObject = { assetId: string; bytes: Uint8Array; customMetadata: Record<string, string> };

export async function publicMediaResponse(request: Request, env: AppEnv['Bindings'], assetId: string): Promise<Response> {
  assetId = assetId.replace(/\.webp$/i, '');
  if (!/^[A-Za-z0-9_-]{16,100}$/.test(assetId) || env.MEDIA_MODE !== 'r2' || !env.IMAGES) return new Response('Not found\n', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  if(env.CONTENT_MODE==='live'){
    const asset=await env.DB.prepare("SELECT object_key,entity_type,entity_id FROM media_assets WHERE id=? AND object_state='published' AND permission='approved'").bind(assetId).first<{object_key:string;entity_type:string;entity_id:string}>();
    if(!asset)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
    const record=await env.DB.prepare("SELECT payload_json FROM catalog_mirror WHERE entity_type=? AND entity_id=?").bind(asset.entity_type,asset.entity_id).first<{payload_json:string}>();
    const entity=record?JSON.parse(record.payload_json):null;
    const allowed=entity&&entity.status!=='archived'&&entity.images.some((image:any)=>image.url===`https://eat.shoumc.com/media/${assetId}.webp`&&!image.hidden&&image.permission==='approved');
    if(!allowed)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
    const targetType=asset.entity_type==='review'?entity.targetType:asset.entity_type==='food'?'venue':null;
    const targetId=asset.entity_type==='review'?entity.targetId:asset.entity_type==='food'?entity.venueId:null;
    if(targetType){
      const target=await env.DB.prepare("SELECT payload_json FROM catalog_mirror WHERE entity_type=? AND entity_id=? AND COALESCE(json_extract(payload_json,'$.status'),'published')!='archived'").bind(targetType,targetId).first<{payload_json:string}>();
      if(!target)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
      if(targetType==='food'){
        const parent=await env.DB.prepare("SELECT entity_id FROM catalog_mirror WHERE entity_type='venue' AND entity_id=? AND COALESCE(json_extract(payload_json,'$.status'),'published')!='archived'").bind(JSON.parse(target.payload_json).venueId).first();
        if(!parent)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
      }
    }
    const object=await env.IMAGES.get(asset.object_key);
    if(!object)return new Response('Not found',{status:404,headers:{'Cache-Control':'no-store'}});
    return new Response(object.body,{headers:{'Content-Type':'image/webp','Cache-Control':'no-store'}});
  }
  const object = await env.IMAGES.get(mediaObjectKey(assetId));
  if (!object || object.customMetadata?.visibility !== 'published' || object.customMetadata.assetId !== assetId) return new Response('Not found\n', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const etag = object.httpEtag;
  if (etag && request.headers.get('If-None-Match') === etag) return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'public, max-age=31536000, immutable' } });
  const headers = new Headers({ 'Content-Type': 'image/webp', 'Cache-Control': 'public, max-age=31536000, immutable' });
  if (etag) headers.set('ETag', etag);
  return new Response(object.body, { status: 200, headers });
}

export async function privateMediaResponse(env: AppEnv['Bindings'], objectKey: string): Promise<Response> {
  if (!env.IMAGES) return new Response('Not found\n', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  const object = await env.IMAGES.get(objectKey);
  if (!object) return new Response('Not found\n', { status: 404, headers: { 'Cache-Control': 'no-store' } });
  return new Response(object.body, { status: 200, headers: { 'Content-Type': 'image/webp', 'Cache-Control': 'private, no-store' } });
}

function ascii(bytes: Uint8Array, offset: number, length: number): string { return String.fromCharCode(...bytes.subarray(offset, offset + length)); }
function readUint16(bytes: Uint8Array, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8); }
function readUint24(bytes: Uint8Array, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16); }
function readUint32(bytes: Uint8Array, offset: number): number { return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24 >>> 0); }
