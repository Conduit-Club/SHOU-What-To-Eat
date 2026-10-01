import { useMemo, useState } from 'react';

type Restaurant = { id: string; name: string; category: 'on-campus' | 'off-campus'; kind: string; location: string; price: string; reviews: { text: string; author: string | null }[] };
type Props = { restaurants: Restaurant[] };

export default function RestaurantFinder({ restaurants }: Props) {
  const [category, setCategory] = useState<'all' | 'on-campus' | 'off-campus'>('all');
  const [query, setQuery] = useState('');
  const [suggestion, setSuggestion] = useState<string | null>(null);
  const results = useMemo(() => restaurants.filter((restaurant) => {
    const matchesCategory = category === 'all' || restaurant.category === category;
    const terms = `${restaurant.name} ${restaurant.kind} ${restaurant.location} ${restaurant.price} ${restaurant.reviews.map((review) => review.text).join(' ')}`;
    return matchesCategory && terms.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  }), [category, query, restaurants]);

  return <section className="finder" aria-label="餐饮目录">
    <div className="toolbar">
      <div className="filters" role="group" aria-label="餐厅范围">
        {([['all', '全部'], ['on-campus', '校内'], ['off-campus', '校外']] as const).map(([value, label]) => <button className={category === value ? 'filter active' : 'filter'} key={value} onClick={() => setCategory(value)} aria-pressed={category === value}>{label}</button>)}
      </div>
      <label className="search"><span aria-hidden="true">⌕</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜餐厅、餐品或位置" aria-label="搜索餐厅、餐品或位置" /></label>
      <button className="pick" onClick={() => setSuggestion(results.length ? results[Math.floor(Math.random() * results.length)].id : null)} disabled={!results.length}><span aria-hidden="true">✳</span> 帮我选一家</button>
    </div>
    {suggestion && results.some((restaurant) => restaurant.id === suggestion) && <p className="suggestion" role="status">今天可以试试「{results.find((restaurant) => restaurant.id === suggestion)?.name}」 <button onClick={() => setSuggestion(null)} aria-label="关闭推荐">×</button></p>}
    <p className="result-count" aria-live="polite">找到 {results.length} 个去处</p>
    {results.length ? <div className="grid">{results.map((restaurant) => <a className="restaurant" href={`/restaurants/${restaurant.id}/`} key={restaurant.id}>
      <div className="restaurant-top"><span className="kind">{restaurant.kind}</span><span className="arrow" aria-hidden="true">↗</span></div>
      <h2>{restaurant.name}</h2><p className="location"><span aria-hidden="true">⌖</span> {restaurant.location}</p>
      <p className="price">{restaurant.price}</p><div className="card-bottom"><span>{restaurant.reviews.length ? `${restaurant.reviews.length} 条同学体验` : '暂无评价'}</span><span className="detail">详情 <span aria-hidden="true">→</span></span></div>
    </a>)}</div> : <div className="empty"><span aria-hidden="true">⌕</span><p>没有找到相关餐厅</p><button onClick={() => { setCategory('all'); setQuery(''); }}>清除筛选</button></div>}
    <style>{`
      .toolbar{display:flex;align-items:center;gap:14px;padding-bottom:22px;border-bottom:1px solid var(--line)}
      .filters{display:flex;flex-shrink:0;gap:3px;padding:3px;border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb,var(--ink) 3%,transparent)}
      .filter{min-width:44px;min-height:44px;padding:0 12px;border:0;border-radius:5px;background:transparent;color:var(--muted);font-size:12px;cursor:pointer}
      .filter.active{background:var(--ink);color:var(--page-bg,#f7f8f5)}
      .search{display:flex;align-items:center;gap:9px;flex:1;min-width:0;max-width:360px;min-height:44px;padding:0 11px;border:1px solid var(--line);border-radius:7px;color:var(--muted)}
      .search>span{flex:0 0 auto;font-size:20px;line-height:1}
      .search input{width:100%;min-width:0;min-height:40px;padding:0;border:0;background:transparent;color:var(--ink);font-size:13px;outline:0}
      .search:focus-within{border-color:var(--focus);outline:3px solid var(--focus);outline-offset:2px}
      .search input::placeholder{color:var(--muted)}
      .pick{min-height:44px;padding:0 14px;border:0;border-radius:7px;background:color-mix(in srgb,var(--green) 20%,var(--page-bg));color:var(--ink);font-size:12px;font-weight:650;cursor:pointer}
      .pick span{color:var(--green)}
      .pick:disabled{opacity:.5;cursor:not-allowed}
      .result-count{margin:20px 0 11px;color:var(--muted);font-size:11px}
      .grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:13px}
      .restaurant{display:flex;min-width:0;min-height:191px;flex-direction:column;padding:16px 17px 13px;border:1px solid var(--line);border-radius:8px;background:color-mix(in srgb,var(--ink) 1.7%,transparent);text-decoration:none;transition:border-color .15s,transform .15s}
      .restaurant:hover{border-color:#cb997d;transform:translateY(-2px)}
      .restaurant-top,.card-bottom{display:flex;align-items:center;justify-content:space-between;min-width:0}
      .kind{color:var(--green);font-size:10px}
      .arrow{color:var(--muted);font-size:14px}
      .restaurant h2{margin:19px 0 6px;font-size:18px;line-height:1.4;font-weight:680;letter-spacing:0;overflow-wrap:anywhere}
      .location{display:-webkit-box;overflow:hidden;margin:0;color:var(--muted);font-size:13px;line-height:1.65;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
      .location span{color:var(--orange)}
      .price{display:-webkit-box;overflow:hidden;margin:10px 0;color:var(--ink);font-size:13px;line-height:1.65;overflow-wrap:anywhere;-webkit-box-orient:vertical;-webkit-line-clamp:2}
      .card-bottom{gap:8px;padding-top:11px;margin-top:auto;border-top:1px solid var(--line);color:var(--muted);font-size:12px}
      .card-bottom>span{min-width:0;overflow-wrap:anywhere}
      .detail{flex:0 0 auto;color:var(--orange);font-weight:600}
      .suggestion{display:flex;align-items:center;gap:8px;margin:14px 0 0;padding:7px 7px 7px 13px;border:1px solid #dfc9bd;border-radius:7px;background:color-mix(in srgb,var(--orange) 9%,transparent);font-size:13px;line-height:1.6;overflow-wrap:anywhere}
      .suggestion button{display:grid;flex:0 0 44px;width:44px;min-height:44px;place-items:center;margin-left:auto;border:0;background:transparent;color:var(--muted);font-size:17px;cursor:pointer}
      .empty{display:grid;justify-items:center;padding:70px 20px;color:var(--muted);text-align:center}
      .empty>span{font-size:26px}
      .empty p{font-size:14px}
      .empty button{min-height:44px;padding:0 13px;border:1px solid var(--line);border-radius:6px;background:transparent;color:var(--ink);font-size:12px;cursor:pointer}
      @media(max-width:760px){.grid{grid-template-columns:repeat(2,minmax(0,1fr))}}
      @media(max-width:560px){
        .toolbar{flex-wrap:wrap;gap:9px}
        .filters{order:0}
        .search{order:2;max-width:none;flex-basis:100%}
        .pick{order:1;margin-left:auto}
        .grid{grid-template-columns:1fr;gap:9px}
        .restaurant{min-height:155px;padding:14px 15px 12px}
        .restaurant h2{margin-top:12px;font-size:16px}
        .price{margin:7px 0}
        .filter{padding:0 10px}
        .suggestion{font-size:12px}
        .search input{font-size:16px}
      }
      @media(max-width:360px){
        .toolbar{gap:8px}
        .filters{flex:1;min-width:0}
        .filter{padding:0 7px}
        .pick{padding:0 10px}
      }
    `}</style>
  </section>;
}
