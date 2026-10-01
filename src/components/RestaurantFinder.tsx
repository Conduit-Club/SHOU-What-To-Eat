import { useMemo, useState } from 'react';
import { formatLocation, formatPrice, kindLabel, mealLabel, safePublicImage, tagLabel, type CatalogImage, type CatalogLocation, type CatalogPrice } from '../utils/catalog-display';

type LocationValue = CatalogLocation | { label?: string; name?: string; address?: string; building?: string; floor?: string };
type ImageRef = CatalogImage | string;
type Review = { text: string; author: string | null };
type Restaurant = {
  id: string;
  name: string;
  category: 'on-campus' | 'off-campus';
  kind?: string;
  location: LocationValue;
  price?: CatalogPrice | null;
  averagePrice?: CatalogPrice | null;
  reviews?: Review[];
  reviewCount?: number;
  aliases?: string[];
  tags?: string[];
  images?: ImageRef[];
};
type Food = {
  id: string;
  name: string;
  venueId: string;
  mealTypes?: string[];
  price?: CatalogPrice | null;
  tags?: string[];
  description?: string | null;
};
type Props = { restaurants: Restaurant[]; foods?: Food[] };

function locationText(location: LocationValue) {
  if (typeof location === 'object' && ('label' in location || 'name' in location || 'building' in location)) {
    return [location.label, location.name, location.address, location.building, location.floor].filter(Boolean).join(' · ') || '位置待补充';
  }
  return formatLocation(location as CatalogLocation);
}

function priceText(restaurant: Restaurant) {
  return formatPrice(restaurant.price ?? restaurant.averagePrice);
}

function priceRange(price: CatalogPrice | null | undefined): [number, number] | null {
  if (typeof price === 'number' && Number.isFinite(price)) return [price, price];
  if (!price || typeof price !== 'object') return null;
  if (typeof price.amount === 'number' && Number.isFinite(price.amount)) return [price.amount, price.amount];
  if (typeof price.amountCents === 'number' && Number.isFinite(price.amountCents)) {
    const amount = price.amountCents / 100;
    return [amount, amount];
  }
  const min = typeof price.minCents === 'number' && Number.isFinite(price.minCents) ? price.minCents / 100 : null;
  const max = typeof price.maxCents === 'number' && Number.isFinite(price.maxCents) ? price.maxCents / 100 : null;
  if (min !== null && max !== null) return [min, max];
  return min !== null ? [min, min] : max !== null ? [max, max] : null;
}

function reviewCount(restaurant: Restaurant) {
  return restaurant.reviews?.length ?? restaurant.reviewCount ?? 0;
}

function searchTerms(restaurant: Restaurant, foods: Food[]) {
  return [
    restaurant.name,
    restaurant.kind,
    locationText(restaurant.location),
    priceText(restaurant),
    ...(restaurant.aliases ?? []),
    ...(restaurant.tags ?? []),
    ...(restaurant.reviews ?? []).map((review) => review.text),
    ...foods.flatMap((food) => [food.name, food.description, formatPrice(food.price), ...(food.mealTypes ?? []).map((meal) => mealLabel(meal)), ...(food.tags ?? []), ...(food.tags ?? []).map(tagLabel)]),
  ].filter(Boolean).join(' ').toLocaleLowerCase();
}

function hasPriceInBand(price: CatalogPrice | null | undefined, band: PriceBand) {
  if (band === 'all') return true;
  const range = priceRange(price);
  if (!range) return false;
  const [min, max] = range;
  if (band === 'known') return true;
  if (band === 'under20') return min <= 20;
  if (band === '20to40') return max >= 20 && min <= 40;
  return max >= 40;
}

type MealType = 'all' | 'breakfast' | 'meal' | 'snack' | 'dessert' | 'drink';
type PriceBand = 'all' | 'known' | 'under20' | '20to40' | 'over40';

export function matchesFoodFilters(restaurant: Restaurant, relatedFoods: Food[], mealType: MealType, priceBand: PriceBand, tag: string) {
  const mealSelected = mealType !== 'all';
  const priceSelected = priceBand !== 'all';
  const tagSelected = tag !== 'all';
  const venueTagMatches = !tagSelected || (restaurant.tags ?? []).includes(tag);
  const venuePriceMatches = priceSelected && hasPriceInBand(restaurant.averagePrice ?? restaurant.price, priceBand);
  const sameFoodMatches = relatedFoods.some((food) => {
    const mealMatches = !mealSelected || food.mealTypes?.includes(mealType);
    const priceMatches = !priceSelected || hasPriceInBand(food.price, priceBand);
    const tagMatches = !tagSelected || venueTagMatches || (food.tags ?? []).includes(tag);
    return mealMatches && priceMatches && tagMatches;
  });

  // A venue's own price may satisfy a price filter when no meal is selected;
  // otherwise a meal and its price/tag must come from the same food record.
  if (!mealSelected && venueTagMatches && venuePriceMatches) return true;
  if (!relatedFoods.length) return !mealSelected && venueTagMatches && (!priceSelected || venuePriceMatches);
  return sameFoodMatches;
}

export default function RestaurantFinder({ restaurants, foods = [] }: Props) {
  const [category, setCategory] = useState<'all' | 'on-campus' | 'off-campus'>('all');
  const [query, setQuery] = useState('');
  const [mealType, setMealType] = useState<MealType>('all');
  const [priceBand, setPriceBand] = useState<PriceBand>('all');
  const [tag, setTag] = useState('all');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const foodsByVenue = useMemo(() => {
    const grouped = new Map<string, Food[]>();
    for (const food of foods) grouped.set(food.venueId, [...(grouped.get(food.venueId) ?? []), food]);
    return grouped;
  }, [foods]);
  const availableTags = useMemo(() => {
    const values = new Set<string>();
    for (const restaurant of restaurants) for (const value of restaurant.tags ?? []) {
      const label = tagLabel(value);
      if (label !== '校内' && label !== '校外') values.add(value);
    }
    for (const food of foods) for (const value of food.tags ?? []) values.add(value);
    return [...values].sort((a, b) => tagLabel(a).localeCompare(tagLabel(b), 'zh-CN'));
  }, [foods, restaurants]);
  const results = useMemo(() => restaurants.filter((restaurant) => {
    const relatedFoods = foodsByVenue.get(restaurant.id) ?? [];
    const matchesCategory = category === 'all' || restaurant.category === category;
    const matchesQuery = searchTerms(restaurant, relatedFoods).includes(query.trim().toLocaleLowerCase());
    return matchesCategory && matchesQuery && matchesFoodFilters(restaurant, relatedFoods, mealType, priceBand, tag);
  }), [category, foodsByVenue, mealType, priceBand, query, restaurants, tag]);

  const pickRandom = () => setSuggestion(results.length ? results[Math.floor(Math.random() * results.length)].id : null);

  return <section className="finder" aria-label="餐饮目录">
    <div className="finder-layout">
      <aside className="finder-controls" aria-label="筛选与抽签">
        <p className="control-kicker"><span aria-hidden="true">✦</span> 今日灵感</p>
        <h2>随便挑一口</h2>
        <p className="control-copy">用范围和关键词缩小选择，也可以把决定交给抽签。</p>
        <div className="filter-block">
          <span className="field-label">想去哪里</span>
          <div className="filters" role="group" aria-label="餐厅范围">
            {([['all', '全部'], ['on-campus', '校内'], ['off-campus', '校外']] as const).map(([value, label]) => <button className={category === value ? 'filter active' : 'filter'} key={value} onClick={() => setCategory(value)} aria-pressed={category === value}>{label}</button>)}
          </div>
        </div>
        <div className="advanced-filters" aria-label="餐品筛选">
          <label><span>餐段</span><select value={mealType} onChange={(event) => setMealType(event.target.value as MealType)}><option value="all">全部餐段</option><option value="breakfast">早餐</option><option value="meal">正餐</option><option value="snack">小吃</option><option value="dessert">甜点</option><option value="drink">饮品</option></select></label>
          <label><span>价格</span><select value={priceBand} onChange={(event) => setPriceBand(event.target.value as PriceBand)}><option value="all">全部价格</option><option value="known">已有价格</option><option value="under20">20 元内</option><option value="20to40">20–40 元</option><option value="over40">40 元以上</option></select></label>
          {availableTags.length > 0 && <label><span>标签</span><select value={tag} onChange={(event) => setTag(event.target.value)}><option value="all">全部标签</option>{availableTags.map((value) => <option value={value} key={value}>{tagLabel(value)}</option>)}</select></label>}
        </div>
        <label className="search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜餐厅、餐品或位置" aria-label="搜索餐厅、餐品或位置" /></label>
        <button className="pick" onClick={pickRandom} disabled={!results.length}>
          <span className="pick-icon" aria-hidden="true">✦</span><span>帮我选一家</span><small>{results.length ? '随机来点新鲜的' : '暂无可选去处'}</small>
        </button>
        {suggestion && results.some((restaurant) => restaurant.id === suggestion) && <p className="suggestion" role="status"><span>今天可以试试「{results.find((restaurant) => restaurant.id === suggestion)?.name}」</span><button onClick={() => setSuggestion(null)} aria-label="关闭推荐">×</button></p>}
      </aside>
      <div className="discovery">
        <header className="discovery-head">
          <div><p className="section-kicker">DISCOVER</p><h2>附近好味道</h2><p className="result-count" aria-live="polite">找到 {results.length} 个去处</p></div>
          <span className="discovery-note">同学分享 · 持续补充</span>
        </header>
        {results.length ? <div className="grid">{results.map((restaurant) => {
          const image = safePublicImage(restaurant.images?.[0]);
          const count = reviewCount(restaurant);
          const relatedFoods = foodsByVenue.get(restaurant.id) ?? [];
          return <a className="restaurant" href={`/restaurants/${restaurant.id}/`} key={restaurant.id}>
            <div className="restaurant-image">
              {image ? <img src={image.url} alt={image.alt} loading="lazy" referrerPolicy="no-referrer" /> : <div className="photo-placeholder" role="img" aria-label="暂无图片"><svg viewBox="0 0 80 64" aria-hidden="true"><path d="M16 44c0-13 10-24 24-24s24 11 24 24" /><path d="M12 45h56M24 45v7h32v-7M28 21l4-8h16l4 8" /><circle cx="40" cy="31" r="5" /></svg><span>暂无图片</span></div>}
              <div className="image-badges"><span>{restaurant.category === 'on-campus' ? '校内' : '校外'}</span><span>{kindLabel(restaurant.kind)}</span></div>
            </div>
            <div className="restaurant-body">
              <div className="restaurant-heading"><h3>{restaurant.name}</h3><span className="arrow" aria-hidden="true">↗</span></div>
              <p className="location"><span aria-hidden="true">⌖</span> {locationText(restaurant.location)}</p>
              {relatedFoods.length > 0 && <p className="food-preview"><span aria-hidden="true">✦</span> {relatedFoods.slice(0, 2).map((food) => food.name).join(' · ')}{relatedFoods.length > 2 ? ' · …' : ''}</p>}
              <div className="restaurant-meta"><span className="price">{priceText(restaurant)}</span>{restaurant.tags?.map(tagLabel).find((tag) => tag !== '校内' && tag !== '校外') && <span className="tag">{restaurant.tags.map(tagLabel).find((tag) => tag !== '校内' && tag !== '校外')}</span>}</div>
            </div>
            <div className="card-bottom"><span>{count ? `${count} 条同学体验` : '暂无评价'}</span><span className="detail">查看详情 <span aria-hidden="true">→</span></span></div>
          </a>;
        })}</div> : <div className="empty"><div className="empty-icon" aria-hidden="true">⌕</div><p>没有找到相关餐厅或餐品</p><button onClick={() => { setCategory('all'); setQuery(''); setMealType('all'); setPriceBand('all'); setTag('all'); }}>清除筛选</button></div>}
      </div>
    </div>
    <style>{`
      .finder{padding:0 0 8px}
      .finder-layout{display:grid;grid-template-columns:minmax(260px,320px) minmax(0,1fr);gap:32px;align-items:start}
      .finder-controls{position:sticky;top:24px;min-width:0;padding:26px;border:1px solid rgba(255,107,53,.1);border-radius:28px;background:var(--surface-card);box-shadow:var(--shadow-card)}
      .control-kicker,.section-kicker{margin:0;color:var(--orange-deep);font-size:11px;font-weight:800;letter-spacing:.13em}
      .control-kicker span{color:var(--honey);font-size:16px}
      .finder-controls h2,.discovery-head h2{margin:10px 0 8px;color:var(--ink);font-size:26px;line-height:1.2;letter-spacing:-.03em}
      .control-copy{margin:0;color:var(--muted);font-size:13px;line-height:1.75}
      .filter-block{margin-top:25px}
      .field-label{display:block;margin-bottom:9px;color:var(--ink);font-size:12px;font-weight:800}
      .filters{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:5px;padding:4px;border-radius:14px;background:#f4f0eb}
      .filter{min-width:0;min-height:44px;padding:0 7px;border:0;border-radius:11px;background:transparent;color:var(--muted);font-size:12px;font-weight:700;cursor:pointer}
      .filter.active{background:var(--ink);color:#fff}
      .search{display:flex;align-items:center;gap:10px;min-height:50px;margin-top:16px;padding:0 15px;border:1px solid var(--line);border-radius:var(--radius-control);background:var(--surface-soft);color:var(--muted);transition:border-color .2s,box-shadow .2s}
      .search>span{flex:0 0 auto;font-size:22px;line-height:1}
      .search input{width:100%;min-width:0;min-height:44px;padding:0;border:0;background:transparent;color:var(--ink);font-size:16px;outline:0}
      .search:focus-within{border-color:var(--orange);box-shadow:0 0 0 4px rgba(255,107,53,.15)}
      .search input::placeholder{color:#a5a8b5}
      .pick{display:grid;grid-template-columns:auto 1fr;align-items:center;column-gap:10px;width:100%;min-height:62px;margin-top:14px;padding:10px 18px;border:0;border-radius:18px;background:linear-gradient(135deg,var(--orange),var(--orange-deep));box-shadow:0 14px 26px -12px rgba(255,107,53,.55);color:#fff;text-align:left;transition:transform .2s,box-shadow .2s;cursor:pointer}
      .pick:hover{transform:translateY(-2px);box-shadow:var(--shadow-hover)}
      .pick:active{transform:scale(.97)}
      .pick:disabled{opacity:.5;cursor:not-allowed;transform:none}
      .pick-icon{grid-row:span 2;font-size:24px}
      .pick>span:nth-child(2){font-size:14px;font-weight:800}
      .pick small{color:#ffe5db;font-size:10px;line-height:1.4}
      .suggestion{display:flex;align-items:center;gap:8px;margin:14px 0 0;padding:8px 8px 8px 13px;border:1px solid #ffd5c8;border-radius:16px;background:#fff2eb;color:var(--orange-deep);font-size:12px;line-height:1.6;overflow-wrap:anywhere}
      .suggestion>span{min-width:0}
      .suggestion button{display:grid;flex:0 0 44px;width:44px;min-height:44px;place-items:center;margin-left:auto;border:0;border-radius:12px;background:transparent;color:var(--muted);font-size:18px;cursor:pointer}
      .discovery{min-width:0}
      .discovery-head{display:flex;align-items:end;justify-content:space-between;gap:16px;margin:4px 0 18px}
      .discovery-head h2{margin-top:8px;font-size:32px}
      .result-count{margin:0;color:var(--muted);font-size:13px;line-height:1.5}
      .discovery-note{align-self:center;color:var(--muted);font-size:11px;font-weight:700}
      .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px}
      .restaurant{display:flex;min-width:0;overflow:hidden;flex-direction:column;border:1px solid rgba(45,49,66,.07);border-radius:var(--radius-card);background:var(--surface-card);box-shadow:var(--shadow-card);text-decoration:none;transition:transform .2s,box-shadow .2s,border-color .2s}
      .restaurant:hover{border-color:rgba(255,107,53,.2);box-shadow:var(--shadow-hover);transform:translateY(-3px)}
      .restaurant-image{position:relative;aspect-ratio:16/10;overflow:hidden;background:#f5eee7}
      .restaurant-image>img{display:block;width:100%;height:100%;object-fit:cover;transition:transform .35s}
      .restaurant:hover .restaurant-image>img{transform:scale(1.03)}
      .photo-placeholder{display:grid;width:100%;height:100%;place-items:center;align-content:center;gap:5px;background:radial-gradient(circle at 55% 25%,#fffdf9 0 6%,transparent 7%),linear-gradient(135deg,#fff7f0,#f4e6db);color:#b89a8d;font-size:11px;font-weight:700}
      .photo-placeholder svg{width:72px;height:58px;fill:none;stroke:#d3ad9b;stroke-linecap:round;stroke-linejoin:round;stroke-width:2}
      .image-badges{position:absolute;top:12px;right:12px;left:12px;display:flex;justify-content:space-between;gap:8px}
      .image-badges span{padding:6px 9px;border-radius:999px;background:rgba(255,255,255,.88);color:var(--ink);font-size:10px;font-weight:800;backdrop-filter:blur(8px)}
      .image-badges span+span{color:var(--orange-deep)}
      .restaurant-body{min-width:0;padding:18px 19px 14px}
      .restaurant-heading,.restaurant-meta,.card-bottom{display:flex;align-items:center;justify-content:space-between;min-width:0;gap:10px}
      .restaurant-heading h3{min-width:0;margin:0;color:var(--ink);font-size:20px;line-height:1.3;font-weight:800;letter-spacing:-.02em;overflow-wrap:anywhere}
      .arrow{flex:0 0 auto;color:var(--orange);font-size:18px}
      .location{display:-webkit-box;overflow:hidden;margin:9px 0 15px;color:var(--muted);font-size:14px;line-height:1.6;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
      .location span{color:var(--orange)}
      .food-preview{display:-webkit-box;overflow:hidden;margin:-6px 0 12px;color:var(--green);font-size:12px;line-height:1.5;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:1}
      .food-preview span{margin-right:4px;color:var(--honey)}
      .restaurant-meta{justify-content:flex-start;flex-wrap:wrap}
      .price{color:var(--ink);font-size:14px;font-weight:800;overflow-wrap:anywhere}
      .tag{padding:5px 9px;border-radius:999px;background:#f0fff4;color:#2e9d60;font-size:11px;font-weight:800}
      .card-bottom{padding:13px 19px 17px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
      .card-bottom>span{min-width:0;overflow-wrap:anywhere}
      .detail{flex:0 0 auto;color:var(--orange-deep);font-weight:800}
      .empty{display:grid;justify-items:center;padding:80px 20px;border:1px dashed #e1d5cc;border-radius:24px;color:var(--muted);text-align:center}
      .empty-icon{font-size:34px;color:var(--orange)}
      .empty p{font-size:14px}
      .empty button{min-height:44px;padding:0 16px;border:1.5px solid var(--orange);border-radius:999px;background:transparent;color:var(--orange-deep);font-size:12px;font-weight:800;cursor:pointer}
      @media(max-width:1000px){.finder-layout{grid-template-columns:minmax(230px,280px) minmax(0,1fr);gap:24px}.finder-controls{padding:22px}.grid{gap:14px}.restaurant-body{padding:16px}.restaurant-heading h3{font-size:18px}.card-bottom{padding:12px 16px 15px}}
      @media(max-width:760px){.finder-layout{grid-template-columns:1fr;gap:30px}.finder-controls{position:static}.discovery-head{margin-top:0}.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      .advanced-filters{display:grid;gap:10px;margin-top:17px}
      .advanced-filters label{display:grid;grid-template-columns:56px minmax(0,1fr);align-items:center;gap:8px;min-width:0;color:var(--muted);font-size:11px;font-weight:700}
      .advanced-filters select{width:100%;min-width:0;min-height:44px;padding:0 30px 0 11px;border:1px solid var(--line);border-radius:12px;background:var(--surface-soft);color:var(--ink);font:inherit;font-size:13px}
      @media(max-width:760px){.search input{font-size:16px}.advanced-filters{grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.advanced-filters label{display:block}.advanced-filters label span{display:block;margin:0 0 5px}}
      @media(max-width:560px){.finder-controls{padding:20px;border-radius:24px}.discovery-head{display:block}.discovery-head h2{font-size:27px}.discovery-note{display:block;margin-top:8px}.grid{grid-template-columns:1fr;gap:14px}.restaurant-image{aspect-ratio:16/9}.restaurant-heading h3{font-size:20px}.advanced-filters{grid-template-columns:1fr 1fr}.advanced-filters label:last-child{grid-column:1/-1}}
      @media(max-width:360px){.finder-controls{padding:18px}.filters{gap:3px}.filter{font-size:11px}.restaurant-body{padding-right:16px;padding-left:16px}}
    `}</style>
  </section>;
}
