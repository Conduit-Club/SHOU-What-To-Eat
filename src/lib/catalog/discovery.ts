import type { Catalog } from './index.js';
import { deriveDistanceTags } from './index.js';
import { safePublicImage } from '../../utils/catalog-display.js';
import type { DiscoveryCatalog } from '../../utils/catalog-discovery.js';
export function discoveryCatalog(catalog: Catalog): DiscoveryCatalog {
  const ratings = (type: string,id: string) => {
    const reviews = catalog.reviews.filter(review => review.targetType === type && review.targetId === id);
    const rated = reviews.map(review => review.rating).filter((rating): rating is number => rating !== null);
    return { reviewCount: reviews.length,ratedCount: rated.length,rating: rated.length ? rated.reduce((sum,rating) => sum+rating,0)/rated.length : null };
  };
  const venues = catalog.restaurants.map(venue => ({ id:venue.id,name:venue.name,category:venue.category,kind:venue.kind,location:venue.location,tags:deriveDistanceTags(venue),description:venue.description,averagePrice:venue.averagePrice,images:venue.images.filter(image => safePublicImage(image)),addedAt:venue.dates.addedAt,...ratings('venue',venue.id),foodCount:catalog.foods.filter(food => food.venueId === venue.id).length }));
  const map = new Map(venues.map(venue => [venue.id,venue]));
  const foods = catalog.foods.map(food => ({ id:food.id,name:food.name,venueId:food.venueId,venue:map.get(food.venueId) ?? null,mealTypes:food.mealTypes,tags:food.tags,description:food.description,price:food.price,images:food.images.filter(image => safePublicImage(image)),addedAt:food.dates.addedAt,...ratings('food',food.id) }));
  foods.sort((a,b) => Number(b.images.length>0)-Number(a.images.length>0) || a.name.localeCompare(b.name,'zh-CN'));
  venues.sort((a,b) => a.name.localeCompare(b.name,'zh-CN'));
  return { foods,venues };
}
