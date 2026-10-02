/** Submission limits shared by the browser and Worker, matching the public catalog. */
export const SUBMISSION_LIMITS = {
  name: 120, address: 300, area: 100, floor: 100, venueDescription: 2000,
  foodDescription: 1000, priceSource: 300, priceUnit: 20, maxPriceCents: 10_000_000,
  tag: 60, tags: 30, reviewText: 256, entityImages: 6, reviewImages: 3,
  imageAlt: 200, imageSource: 480, imageHolder: 160, imageLicense: 120,
  inputImageBytes: 12 * 1024 * 1024,
} as const;

export function splitTags(value: string): string[] {
  return value.split(/[\s,，、]+/).map(tag => tag.trim()).filter(Boolean);
}

/** Parse decimal yuan without silently rounding fractional cents or exponential notation. */
export function parseYuan(value: string): number | null {
  if (!/^(?:0|[1-9]\d{0,5})(?:\.\d{1,2})?$/.test(value.trim())) return null;
  const [whole, fraction = ''] = value.trim().split('.');
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  return cents <= SUBMISSION_LIMITS.maxPriceCents ? cents : null;
}

/** Tags are Chinese words, optionally including digits (e.g. 校外500米). */
export function isChineseTag(value: string): boolean { return /^[\p{Script=Han}0-9·]+$/u.test(value) && /\p{Script=Han}/u.test(value); }
