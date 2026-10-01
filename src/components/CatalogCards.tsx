import { useEffect, useRef, useState } from 'react';
import { formatPrice, safePublicImage, tagLabel } from '../utils/catalog-display';
import { imageShape, type CatalogCard } from '../utils/catalog-discovery';
import '../styles/catalog-cards.css';

function Card({ item }: { item: CatalogCard }) {
  const photo=item.images.map(safePublicImage).find(Boolean);
  const [dimensions,setDimensions]=useState({width:photo?.width ?? 0,height:photo?.height ?? 0});
  const shape=imageShape(dimensions.width,dimensions.height);
  const url=(item.type === 'food' ? '/foods/' : '/restaurants/')+encodeURIComponent(item.id)+'/';
  return <article className={'catalog-card shape-'+shape}>
    <a className="catalog-card-main" href={url}>
      <div className={'catalog-photo '+(photo ? '' : 'no-catalog-photo')} style={photo && dimensions.width && dimensions.height ? {aspectRatio:Math.min(2,Math.max(.8,dimensions.width/dimensions.height))} : undefined}>
        {photo ? <><img src={photo.url} alt={photo.alt} width={photo.width ?? undefined} height={photo.height ?? undefined} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={event=>{const image=event.currentTarget;if(image.naturalWidth&&image.naturalHeight)setDimensions({width:image.naturalWidth,height:image.naturalHeight});}}/>{photo.isIllustrative && <span>网络示意图</span>}</> : <><svg viewBox="0 0 200 120" aria-hidden="true"><ellipse cx="100" cy="89" rx="58" ry="7" fill="#e2d1b9"/><path d="M44 52h112c-5 38-29 42-56 42S49 88 44 52Z" fill="#fffaf0" stroke="#cba883" strokeWidth="2"/><ellipse cx="100" cy="52" rx="56" ry="17" fill="#f1d5a9" stroke="#cba883" strokeWidth="2"/><path d="M70 52c10-14 26 13 43-2s20-3 25 2M88 29c-8-11 7-15 0-26" fill="none" stroke="#fff8dc" strokeWidth="5" strokeLinecap="round"/></svg><span>照片待补充</span></>}
      </div>
      <div className="catalog-card-copy"><p className="card-subtitle">{item.subtitle}</p><h3>{item.name}<span aria-hidden="true">↗</span></h3>{item.description && <p className="card-description">{item.description}</p>}<div className="card-tags">{item.tags.slice(0,3).map(tag=><span key={tag}>{tagLabel(tag)}</span>)}</div><div className="card-facts"><strong>{formatPrice(item.price)}</strong><span className="card-rating">{item.rating === null ? '暂未评分' : <><span aria-hidden="true">★</span> {item.rating.toFixed(1)} <small> / 5</small></>}</span></div></div>
    </a>
    <footer><span>{item.reviewCount ? `${item.reviewCount} 条同学评价` : '等你留下第一条体验'}</span><a href={url+'#review-form'}>写评价 ＋</a></footer>
  </article>;
}
export default function CatalogCards({ items, progressive=false, resetKey='' }: {items:CatalogCard[];progressive?:boolean;resetKey?:string}) {
  const [count,setCount]=useState(12);
  const sentinel=useRef<HTMLDivElement>(null);
  useEffect(()=>setCount(12),[resetKey]);
  useEffect(()=>{
    if(!progressive || count>=items.length || !sentinel.current || typeof IntersectionObserver==='undefined')return;
    const observer=new IntersectionObserver(entries=>{if(entries.some(entry=>entry.isIntersecting))setCount(value=>Math.min(value+12,items.length));},{rootMargin:'240px'});
    observer.observe(sentinel.current);return()=>observer.disconnect();
  },[count,items.length,progressive,resetKey]);
  const visible=progressive?items.slice(0,count):items;
  return <><div className="catalog-card-grid">{visible.map(item=><Card item={item} key={item.type+':'+item.id}/>)}</div>{progressive && <div className="load-more-row"><p aria-live="polite">已显示 {visible.length} / {items.length}</p>{visible.length<items.length&&<><div ref={sentinel} aria-hidden="true"/><button type="button" onClick={()=>setCount(value=>Math.min(value+12,items.length))}>加载更多 ↓</button></>}</div>}</>;
}
