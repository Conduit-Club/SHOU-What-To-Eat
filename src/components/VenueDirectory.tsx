import { useState } from 'react';
import CatalogCards from './CatalogCards';
import CatalogShelves from './CatalogShelves';
import { useCatalog } from './useCatalog';
import { venueCard,type DiscoveryCatalog } from '../utils/catalog-discovery';
export default function VenueDirectory({initialCatalog}:{initialCatalog:DiscoveryCatalog}) {
  const {catalog,loading,error,retry}=useCatalog(initialCatalog);
  const [scope,setScope]=useState('all');
  const [kind,setKind]=useState('all');
  const items=catalog.venues.filter(venue=>(scope==='all'||venue.category===scope)&&(kind==='all'||venue.kind===kind));
  return <>
    <CatalogShelves items={catalog.venues.map(venueCard)} type="venue"/>
    <section className="catalog-shelf" id="all-venues" aria-label="全部餐厅与档口"><header className="shelf-heading"><div><h2>从这家店，找到下一顿</h2><p>先看看位置和餐品，再决定去哪吃。</p></div><a href="/search/?type=venue">去搜索页仔细找 →</a></header>
      <div className="venue-filters"><label>范围<select value={scope} onChange={event=>setScope(event.target.value)}><option value="all">全部范围</option><option value="on-campus">校内</option><option value="off-campus">校外</option></select></label><label>类型<select value={kind} onChange={event=>setKind(event.target.value)}><option value="all">全部店铺</option><option value="cafeteria">食堂</option><option value="stall">档口</option><option value="restaurant">餐厅</option><option value="cafe">咖啡 / 饮品店</option><option value="convenience">便利店</option></select></label><span aria-live="polite">{loading?'正在加载…':items.length+' 个去处'}</span></div>
      {error&&<p className="catalog-load-error">完整目录暂时无法载入。 <button onClick={retry}>重试</button></p>}
      {items.length?<CatalogCards items={items.map(venueCard)} progressive resetKey={scope+kind}/>:<p className="shelf-empty">没有符合条件的店铺，放宽范围试试。</p>}
    </section>
    <style>{`.venue-filters{display:flex;align-items:end;gap:15px;flex-wrap:wrap;margin-bottom:24px}.venue-filters label{display:grid;gap:8px;font-size:11px;color:var(--muted)}.venue-filters select{min-height:44px;padding:0 15px;border:1px solid var(--line);border-radius:12px;background:white;color:var(--ink);font-size:14px}.venue-filters>span{margin-left:auto;font-size:11px;color:var(--muted);min-height:44px;display:flex;align-items:center}@media(max-width:500px){.venue-filters{gap:10px}.venue-filters label{flex:1}.venue-filters select{width:100%;font-size:16px}.venue-filters>span{flex-basis:100%;margin:0}}`}</style>
  </>;
}
