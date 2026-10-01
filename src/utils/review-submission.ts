/** Receipt-authenticated review transport. Public catalog browsing stays static. */
export type ReviewReceipt = { submissionId: string; receiptToken: string; version: number; type: 'review'; expectedImages: number; expectedReviewImages: 0 };
export type ReviewImage = { blob: Blob; alt: string; source: string; holder: string; license: string; rightsConfirmed: boolean; isIllustrative: boolean };
type Fetcher = typeof fetch;
export class ReviewRequestError extends Error {
  constructor(message: string, public code: string, public status: number, public submissionId?: string) { super(message); }
}
async function request(path: string, options: RequestInit, send: Fetcher) {
  const response = await send(path, options);
  let body;
  try { body = await response.json(); } catch { throw new ReviewRequestError('服务暂时未返回有效响应，请稍后重试。', 'invalid_response', response.status); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ReviewRequestError('服务暂时未返回有效响应，请稍后重试。', 'invalid_response', response.status);
  if (!response.ok) throw new ReviewRequestError(body.error?.message || '评价提交失败，请稍后重试。', body.error?.code ?? 'request_failed', response.status, body.submissionId);
  return body;
}
export async function createReview(input: { snapshotId: string; targetType: 'venue' | 'food'; targetId: string; rating: number; text: string; imageCount: number; turnstileToken: string; idempotencyKey: string }, send: Fetcher = fetch): Promise<ReviewReceipt> {
  if (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 5 || Array.from(input.text).length > 256 || !Number.isInteger(input.imageCount) || input.imageCount < 0 || input.imageCount > 3) throw new Error('请选择 1–5 星，文字不超过 256 字，图片最多 3 张。');
  const body = await request('/api/v2/submissions', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': input.idempotencyKey }, body: JSON.stringify({ schemaVersion: 2, entityType: 'review', snapshotId: input.snapshotId, payload: { targetType: input.targetType, targetId: input.targetId, rating: input.rating, text: input.text.trim() }, expectedImages: input.imageCount, expectedReviewImages: 0, turnstileToken: input.turnstileToken }) }, send);
  if (typeof body.submissionId !== 'string' || typeof body.receiptToken !== 'string' || !body.receiptToken || !Number.isSafeInteger(body.version)) throw new ReviewRequestError('未能取得完整回执，请保留页面并稍后重试。', 'invalid_receipt', 502);
  return { submissionId: body.submissionId, receiptToken: body.receiptToken, version: body.version, type: 'review', expectedImages: input.imageCount, expectedReviewImages: 0 };
}
export async function completeReview(receipt: ReviewReceipt, images: ReviewImage[], onVersion: (version: number) => void, send: Fetcher = fetch): Promise<number> {
  const base = '/api/v2/submissions/' + encodeURIComponent(receipt.submissionId);
  const authorization = { Authorization: 'Bearer ' + receipt.receiptToken };
  const status = await request(base + '/status', { headers: authorization }, send);
  if (!Number.isSafeInteger(status.version) || !Number.isInteger(status.uploadedImages) || status.uploadedImages < 0 || status.uploadedImages > receipt.expectedImages) throw new Error('回执状态无效，请稍后重试。');
  let version: number = status.version;
  onVersion(version);
  if (status.uploadState === 'pending') return version;
  if (status.uploadedImages < receipt.expectedImages && images.length !== receipt.expectedImages) throw new Error(`请重新选择原来的 ${receipt.expectedImages} 张照片，按原顺序继续上传；评分和文字已经保存。`);
  for (let index = status.uploadedImages; index < receipt.expectedImages; index++) {
    const image = images[index];
    if (!image.rightsConfirmed || !image.alt.trim() || !image.source.trim() || !image.holder.trim() || !image.license.trim()) throw new Error('请确认照片使用权，并补全图片说明与来源。');
    const body = await request(base + '/images', { method: 'POST', headers: { ...authorization, 'Content-Type': 'image/webp', 'X-Image-Slot': 'entity', 'X-Image-Index': String(index), 'X-Submission-Version': String(version), 'X-Image-Metadata-Encoding': 'percent-utf8', 'X-Image-Alt': encodeURIComponent(image.alt.trim()), 'X-Image-Source': encodeURIComponent(image.source.trim()), 'X-Image-Copyright-Holder': encodeURIComponent(image.holder.trim()), 'X-Image-License': encodeURIComponent(image.license.trim()), 'X-Image-Rights-Confirmed': 'true', 'X-Image-Is-Illustrative': String(image.isIllustrative) }, body: image.blob }, send);
    if (!Number.isSafeInteger(body.version)) throw new Error('图片回执版本无效，请稍后重试。');
    version = body.version;
    onVersion(version);
  }
  const final = await request(base + '/finalize', { method: 'POST', headers: { ...authorization, 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: version, expectedImages: receipt.expectedImages, expectedReviewImages: 0 }) }, send);
  if (!Number.isSafeInteger(final.version)) throw new Error('完成回执版本无效，请稍后重试。');
  onVersion(final.version);
  return final.version;
}
export async function compressReviewImage(file: File): Promise<Blob> {
  if (!file.type.startsWith('image/') || file.size > 12 * 1024 * 1024) throw new Error('请选择 12 MB 以内的图片。');
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2000 / Math.max(bitmap.width, bitmap.height));
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法读取这张图片。');
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [.84,.72,.6,.48,.36]) {
      const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve,'image/webp',quality));
      if (blob?.type === 'image/webp' && blob.size <= 2 * 1024 * 1024) return blob;
    }
    throw new Error('图片压缩后仍超过 2 MB，请选择较小的照片。');
  } finally { bitmap.close(); }
}
