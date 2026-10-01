import type { Catalog, Food, Image, Review, Venue } from './index.js';

/** Resolve references at build time. A withdrawn review or hidden photo can
 * never remain visible through a previously selected cover. */
export function visibleImages(entity: Food | Venue, type: 'food' | 'venue', reviews: Review[]): (Image & { position?: { x: number; y: number } })[] {
  const own = entity.images.filter(image => image.permission === 'approved' && !image.hidden);
  const cover = entity.cover;
  if (!cover) return own;
  const review = cover.reviewId ? reviews.find(review => review.id === cover.reviewId && review.status !== 'archived' && review.targetType === type && review.targetId === entity.id) : null;
  const selected = cover.reviewId
    ? review?.images.find(image => image.url === cover.url && image.permission === 'approved' && !image.hidden && !image.isIllustrative && image.coverEligible === true)
    : own.find(image => image.url === cover.url && !image.isIllustrative);
  return selected ? [{ ...selected, position: { x: cover.x, y: cover.y } }, ...own.filter(image => image.url !== selected.url)] : own;
}

export function publicCatalog(catalog: Catalog): Catalog {
  const venues = catalog.restaurants.filter(venue => venue.status !== 'archived');
  const venueIds = new Set(venues.map(venue => venue.id));
  const foods = catalog.foods.filter(food => food.status !== 'archived' && venueIds.has(food.venueId));
  const foodIds = new Set(foods.map(food => food.id));
  const reviews = catalog.reviews.filter(review => review.status !== 'archived' && (review.targetType === 'food' ? foodIds : venueIds).has(review.targetId))
    .map(review => ({ ...review, images: review.images.filter(image => image.permission === 'approved' && !image.hidden) }));
  return { schemaVersion: 2,
    restaurants: venues.map(venue => ({ ...venue, foods: venue.foods.filter(id => foodIds.has(id)), images: visibleImages(venue, 'venue', reviews) })),
    foods: foods.map(food => ({ ...food, images: visibleImages(food, 'food', reviews) })), reviews };
}
