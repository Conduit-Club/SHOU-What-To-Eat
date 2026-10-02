import { formatLocation, tagLabel, type CatalogImage, type CatalogLocation, type CatalogPrice } from './catalog-display';

export type DiscoveryVenue = { id: string; name: string; category: string; location: CatalogLocation & { distanceMeters?: number | null; distanceBasis?: string | null }; tags: string[] };
export type DiscoveryFood = { id: string; name: string; venueId: string; venue: DiscoveryVenue | null; mealTypes: string[]; tags: string[]; description: string | null; price: CatalogPrice | null; images: CatalogImage[]; reviewCount: number; rating: number | null; ratedCount?: number; addedAt?: string | null };
export type FoodFilters = { scope: string; budget: string; meal: string; tags: string[]; query: string };

export function matchesDiscoveryFood(food: DiscoveryFood, filters: FoodFilters): boolean {
  const { venue } = food;
  if (filters.scope === 'on-campus' || filters.scope === 'off-campus') {
    if (venue?.category !== filters.scope) return false;
  } else if (filters.scope.startsWith('within-')) {
    const limit = Number(filters.scope.slice(7));
    const location = venue?.location;
    if (venue?.category !== 'off-campus' || !location || typeof location !== 'object' || typeof location.distanceMeters !== 'number' || !location.distanceBasis || location.distanceMeters > limit) return false;
  }
  if (filters.meal !== 'all' && !food.mealTypes.includes(filters.meal)) return false;
  if (filters.tags.some((tag) => !food.tags.map(tagLabel).includes(tagLabel(tag)))) return false;
  if (filters.budget !== 'all') {
    const price = food.price;
    if (!price || typeof price !== 'object') return false;
    const low = price.amountCents ?? price.minCents;
    const high = price.amountCents ?? price.maxCents;
    if (typeof low !== 'number' || typeof high !== 'number') return false;
    if (filters.budget === 'under15' && low >= 1500) return false;
    if (filters.budget === '15to25' && (high < 1500 || low > 2500)) return false;
    if (filters.budget === 'over25' && high <= 2500) return false;
  }
  const query = filters.query.trim().toLocaleLowerCase();
  return !query || [food.name, food.description, venue?.name, formatLocation(venue?.location), ...food.tags, ...food.tags.map(tagLabel)]
    .filter(Boolean).join(' ').toLocaleLowerCase().includes(query);
}

/** Pick only from the current results and avoid repeating the previous choice. */
export function pickFoodId(foods: Pick<DiscoveryFood, 'id'>[], previous: string | null, random = Math.random): string | null {
  const choices = foods.length > 1 ? foods.filter((food) => food.id !== previous) : foods;
  return choices.length ? choices[Math.min(choices.length - 1, Math.floor(random() * choices.length))].id : null;
}
