import { isChineseTag } from '../submission-limits';
import { foodSchema, reviewSchema, venueSchema, type Food, type Review, type Venue } from './index.js';

export type ManagedType = 'venue' | 'food' | 'review';
export type ManagedRecord = Venue | Food | Review;
export function parseManaged(type: ManagedType, value: unknown): ManagedRecord {
  return (type === 'venue' ? venueSchema : type === 'food' ? foodSchema : reviewSchema).parse(value);
}
export function validateManagedEdit(type: ManagedType, before: ManagedRecord, input: unknown): ManagedRecord {
  before = parseManaged(type, before);
  const record = parseManaged(type, input);
  if(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/.test(JSON.stringify(record).replace(/\\u00([0-9a-f]{2})/gi,(_,n)=>String.fromCharCode(parseInt(n,16)))))throw new Error('invalid_control_characters');
  const price=type==='food'?(record as Food).price:type==='venue'?(record as Venue).averagePrice:null;
  if(price && [price.minCents,price.maxCents,'amountCents' in price?price.amountCents:null].some(n=>n!==null&&n!==undefined&&n>10000000))throw new Error('price_out_of_range');
  if(type==='venue'){const venue=record as Venue;if(venue.category==='on-campus'&&venue.location.distanceMeters!==null)throw new Error('on_campus_distance');}

  if (record.id !== before.id) throw new Error('entity_id_immutable');
  if (JSON.stringify(record.sources) !== JSON.stringify(before.sources)) throw new Error('sources_immutable');
  if (record.images.length !== before.images.length || record.images.some((image, index) => {
    const { hidden: _hidden, ...rest } = image;
    const { hidden: _previous, ...original } = before.images[index];
    return JSON.stringify(rest) !== JSON.stringify(original);
  })) throw new Error('image_provenance_immutable');
  if (type === 'review') {
    const oldReview = before as Review, next = record as Review;
    if (next.targetId !== oldReview.targetId || next.targetType !== oldReview.targetType || next.rating !== oldReview.rating || next.text !== oldReview.text || next.authorAlias !== oldReview.authorAlias) throw new Error('review_content_immutable');
  } else {
    const oldEntity = before as Food | Venue, next = record as Food | Venue;
    if(next.tags.some(tag=>!oldEntity.tags.includes(tag)&&!isChineseTag(tag)))throw new Error('chinese_tags_required');
    if (JSON.stringify(next.dates) !== JSON.stringify(oldEntity.dates)) throw new Error('dates_immutable');
    if (type === 'venue' && JSON.stringify((record as Venue).foods) !== JSON.stringify((before as Venue).foods)) throw new Error('food_links_immutable');
  }
  return record;
}

export function validateManagedRelations(type: ManagedType, record: ManagedRecord, records: { type: ManagedType; record: ManagedRecord }[]) {
  const find = (kind: ManagedType, id: string) => records.find(item => item.type === kind && item.record.id === id)?.record;
  if (type === 'venue') {
    const venue = record as Venue;
    if (venue.status === 'archived' && records.some(item => item.record.status !== 'archived' && (item.type === 'food' && (item.record as Food).venueId === venue.id || item.type === 'venue' && (item.record as Venue).parentId === venue.id))) throw new Error('venue_has_active_children');
    const seen = new Set([venue.id]);
    let parentId = venue.parentId;
    while (parentId) {
      if (seen.has(parentId)) throw new Error('venue_parent_cycle');
      seen.add(parentId);
      const parent = find('venue', parentId) as Venue | undefined;
      if (!parent || parent.status === 'archived') throw new Error('parent_venue_unpublished');
      parentId = parent.parentId;
    }
  }
  if (type === 'food' && record.status !== 'archived') {
    const parent = find('venue', (record as Food).venueId);
    if (!parent || parent.status === 'archived') throw new Error('parent_venue_unpublished');
  }
  if (type === 'review') return;
  const entity = record as Food | Venue;
  if (!entity.cover) return;
  const { cover } = entity;
  const review = cover.reviewId ? find('review', cover.reviewId) as Review | undefined : undefined;
  if (cover.reviewId && (!review || review.status === 'archived' || review.targetId !== entity.id || review.targetType !== type)) throw new Error('invalid_cover_review');
  const source = review ? review.images : entity.images;
  const image = source.find(image => image.url === cover.url && image.permission === 'approved' && !image.hidden && !image.isIllustrative);
  if (!image || review && !image.coverEligible) throw new Error('cover_not_eligible');
}
