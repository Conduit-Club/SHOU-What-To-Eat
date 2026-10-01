/** Small display helpers shared by the static catalog pages and the client finder.
 * They deliberately format only values present in the public catalog; no default
 * rating, price, location, or image source is invented here.
 */

export type CatalogLocation = string | {
  address?: string | null;
  campusArea?: string | null;
  floor?: string | null;
  landmark?: string | null;
};

export type CatalogImage = {
  url: string;
  alt?: string | null;
  sourceUrl?: string | null;
  sourceNote?: string | null;
  author?: string | null;
  license?: string | null;
  permission?: 'approved' | 'pending';
  isIllustrative?: boolean;
  hidden?: boolean;
  position?: { x: number; y: number };
  width?: number | null;
  height?: number | null;
};

export type CatalogPrice = string | number | {
  amount?: number | null;
  amountCents?: number | null;
  minCents?: number | null;
  maxCents?: number | null;
  currency?: string;
  unit?: string;
};

export function formatLocation(location: CatalogLocation | null | undefined): string {
  if (!location) return '位置待补充';
  if (typeof location === 'string') return location;
  return [location.address, location.campusArea, location.floor, location.landmark]
    .filter((value): value is string => Boolean(value && value.trim()))
    .filter((value, index, values) => values.indexOf(value) === index)
    .join(' · ') || '位置待补充';
}

function yuan(amount: number): string {
  return Number.isInteger(amount) ? String(amount) : amount.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

export function formatPrice(price: CatalogPrice | null | undefined): string {
  if (price === null || price === undefined || price === '') return '价格待补充';
  if (typeof price === 'string') return price;
  if (typeof price === 'number' && Number.isFinite(price)) return `约 ¥${yuan(price)}`;
  if (typeof price !== 'object') return '价格待补充';
  if (typeof price.amount === 'number' && Number.isFinite(price.amount)) return `¥${yuan(price.amount)}${price.unit ? ` / ${price.unit}` : ''}`;
  if (typeof price.amountCents === 'number' && Number.isFinite(price.amountCents)) return `¥${yuan(price.amountCents / 100)}${price.unit ? ` / ${price.unit}` : ''}`;
  const min = typeof price.minCents === 'number' ? price.minCents / 100 : null;
  const max = typeof price.maxCents === 'number' ? price.maxCents / 100 : null;
  if (min !== null && max !== null) return `¥${yuan(min)}–${yuan(max)}${price.unit ? ` / ${price.unit}` : ''}`;
  return '价格待补充';
}

export type PublicImage = Pick<CatalogImage, 'url' | 'sourceUrl' | 'sourceNote' | 'author' | 'license' | 'isIllustrative' | 'width' | 'height' | 'position'> & { alt: string };

export function safePublicLink(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' || url.username || url.password || ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function licenseLink(license: string | null | undefined): string | null {
  const value = license?.trim();
  if (!value) return null;
  const normalized = value.toLowerCase().replace(/[–—]/g, '-').replace(/\s+/g, ' ');
  const knownLicenses: Record<string, string> = {
    'cc by-sa 4.0': 'https://creativecommons.org/licenses/by-sa/4.0/',
    'cc by-nc-sa 4.0': 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    'cc by 4.0': 'https://creativecommons.org/licenses/by/4.0/',
    'cc0 1.0': 'https://creativecommons.org/publicdomain/zero/1.0/',
  };
  return knownLicenses[normalized] ?? safePublicLink(value);
}

export function safePublicImage(image: CatalogImage | string | null | undefined): PublicImage | null {
  if (!image || (typeof image !== 'string' && image.hidden)) return null;
  const raw = typeof image === 'string' ? image : image.url;
  if (!raw || (typeof image !== 'string' && image.permission === 'pending')) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password || ['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase())) return null;
    if (typeof image === 'string') return { url: raw, alt: '餐饮图片', sourceUrl: null, sourceNote: null, author: null, license: null, isIllustrative: false };
    return {
      url: raw,
      alt: image.alt?.trim() || '餐饮图片',
      sourceUrl: image.sourceUrl ?? null,
      sourceNote: image.sourceNote?.trim() || null,
      author: image.author?.trim() || null,
      license: image.license?.trim() || null,
      isIllustrative: image.isIllustrative ?? false,
      width: image.width ?? null,
      height: image.height ?? null,
      ...(image.position ? { position: image.position } : {}),
    };
  } catch {
    return null;
  }
}

export function kindLabel(kind: string | null | undefined): string {
  const labels: Record<string, string> = {
    cafeteria: '食堂',
    stall: '档口',
    restaurant: '餐厅',
    cafe: '咖啡 / 饮品店',
    convenience: '便利店',
  };
  return kind ? labels[kind] ?? kind : '餐饮点';
}

export function mealLabel(meal: string | null | undefined): string {
  const labels: Record<string, string> = { breakfast: '早餐', meal: '正餐', snack: '小吃', dessert: '甜点', drink: '饮品' };
  return meal ? labels[meal] ?? meal : '餐品';
}

export function tagLabel(tag: string): string {
  const labels: Record<string, string> = {
    breakfast: '早餐',
    canteen: '食堂',
    claypot: '砂锅',
    'cold-noodles': '凉面 / 凉皮',
    'convenience-store': '便利店',
    drink: '饮品',
    dumpling: '饺子',
    'fried-food': '炸物',
    'iron-plate': '铁板',
    korean: '韩式',
    noodles: '面食',
    'on-campus': '校内',
    pancake: '饼类',
    pastry: '糕点',
    porridge: '粥类',
    rice: '米饭类',
    'rice-noodle': '米粉 / 肠粉',
    'roast-meat': '烧腊',
    'set-meal': '套餐 / 打菜',
    'small-plates': '小碟菜',
    soup: '汤类',
    spicy: '辣味',
    'stir-fry': '小炒',
    'within-500m': '500 米内',
    'within-1km': '1 公里内',
    'within-2km': '2 公里内',
    wonton: '馄饨',
    'xinjiang-flavor': '新疆风味',
    'off-campus': '校外',
  };
  return labels[tag] ?? tag;
}
