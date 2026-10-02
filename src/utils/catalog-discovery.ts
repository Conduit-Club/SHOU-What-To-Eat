import { formatLocation, tagLabel, type CatalogImage, type CatalogPrice } from './catalog-display.js';
import { matchesDiscoveryFood, type DiscoveryFood, type DiscoveryVenue, type FoodFilters } from './food-discovery.js';
export type DiscoveryPlace = DiscoveryVenue & { kind: string; description: string | null; images: CatalogImage[]; averagePrice: CatalogPrice | null; reviewCount: number; rating: number | null; ratedCount: number; addedAt: string | null; foodCount: number };
export type DiscoveryCatalog = { foods: DiscoveryFood[]; venues: DiscoveryPlace[] };
export type CatalogCard = { id: string; name: string; type: 'food' | 'venue'; subtitle: string; description: string | null; price: CatalogPrice | null; tags: string[]; images: CatalogImage[]; reviewCount: number; ratedCount?: number; rating: number | null; addedAt: string | null };

export function foodCard(food: DiscoveryFood): CatalogCard { return { ...food,type:'food',subtitle:food.venue?.name ?? '店铺待补充',addedAt:food.addedAt ?? null }; }
export function venueCard(venue: DiscoveryPlace): CatalogCard { return { ...venue,type:'venue',subtitle:formatLocation(venue.location),price:venue.averagePrice }; }
export function topRated<T extends { rating: number | null; ratedCount?: number; name: string }>(items: T[]): T[] {
  return items.filter(item => item.rating !== null).sort((a,b) => b.rating! - a.rating! || (b.ratedCount ?? 0) - (a.ratedCount ?? 0) || a.name.localeCompare(b.name,'zh-CN'));
}
export function newest<T extends { addedAt?: string | null; name: string }>(items: T[]): T[] {
  return items.filter(item => Boolean(item.addedAt)).sort((a,b) => b.addedAt!.localeCompare(a.addedAt!) || a.name.localeCompare(b.name,'zh-CN'));
}
export function imageShape(width?: number | null,height?: number | null): 'wide' | 'portrait' | 'regular' {
  if (!width || !height || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return 'regular';
  return width/height >= 1.55 ? 'wide' : width/height < .9 ? 'portrait' : 'regular';
}
export function matchesDiscoveryVenue(venue: DiscoveryPlace,foods: DiscoveryFood[],filters: FoodFilters): boolean {
  const query=filters.query.trim().toLocaleLowerCase();
  const text=[venue.name,venue.description,formatLocation(venue.location),...venue.tags,...venue.tags.map(tagLabel)].filter(Boolean).join(' ').toLocaleLowerCase();
  const related=foods.filter(food => food.venueId === venue.id);
  const onlyVenueFilters={...filters,meal:'all',tags:[],budget:'all',query:''};
  const proxy: DiscoveryFood={id:venue.id,name:venue.name,venueId:venue.id,venue,mealTypes:[],tags:venue.tags,description:venue.description,price:venue.averagePrice,images:venue.images,reviewCount:venue.reviewCount,rating:venue.rating};
  if(!matchesDiscoveryFood(proxy,onlyVenueFilters))return false;
  const foodFilters={...filters,scope:'all',query:''};
  const venueTags=filters.tags.every(tag => venue.tags.map(tagLabel).includes(tagLabel(tag)));
  if(filters.meal === 'all' && venueTags && matchesDiscoveryFood(proxy,{...foodFilters,tags:[]}))return !query || text.includes(query) || related.some(food => matchesDiscoveryFood(food,{...onlyVenueFilters,scope:'all',query}));
  // All selected food conditions must match the same dish at this venue.
  return related.some(food => matchesDiscoveryFood(food,{...foodFilters,tags:venueTags?[]:filters.tags}) && (!query || text.includes(query) || matchesDiscoveryFood(food,{...onlyVenueFilters,scope:'all',query})));
}

/** A five-review prior tempers isolated ratings; displayed averages stay unchanged. */
export function recommended<T extends {rating:number|null;ratedCount?:number;name:string}>(items:T[]):T[]{
 const rated=items.filter(item=>item.rating!==null && (item.ratedCount??0)>0);
 const mean=3; // Five neutral prior ratings temper low-sample entries.
 const score=(item:T)=>(item.rating!*(item.ratedCount??0)+5*mean)/((item.ratedCount??0)+5);
 return rated.sort((a,b)=>score(b)-score(a)||(b.ratedCount??0)-(a.ratedCount??0)||a.name.localeCompare(b.name,'zh-CN'));
}

/** Directory budgets refer to venue spend, never an unrelated inexpensive dish. */
export function matchesVenueDirectory(venue:DiscoveryPlace,foods:DiscoveryFood[],filters:FoodFilters):boolean {
 if(!matchesDiscoveryVenue(venue,foods,{...filters,meal:'all',budget:'all'}))return false;
 const proxy:DiscoveryFood={id:venue.id,name:venue.name,venueId:venue.id,venue,mealTypes:[],tags:venue.tags,description:venue.description,price:venue.averagePrice,images:venue.images,reviewCount:venue.reviewCount,rating:venue.rating};
 return matchesDiscoveryFood(proxy,{query:'',scope:'all',meal:'all',budget:filters.budget,tags:[]});
}
