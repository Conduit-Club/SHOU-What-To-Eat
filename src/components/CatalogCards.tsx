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
      {photo && <div className={'catalog-photo '+(photo ? '' : 'no-catalog-photo')} style={photo && dimensions.width && dimensions.height ? {aspectRatio:Math.min(2,Math.max(.8,dimensions.width/dimensions.height))} : undefined}>
        {photo ? <><img style={photo.position?{objectPosition:`${photo.position.x}% ${photo.position.y}%`}:undefined} src={photo.url} alt={photo.alt} width={photo.width ?? undefined} height={photo.height ?? undefined} loading="lazy" decoding="async" referrerPolicy="no-referrer" onLoad={event=>{const image=event.currentTarget;if(image.naturalWidth&&image.naturalHeight)setDimensions({width:image.naturalWidth,height:image.naturalHeight});}}/>{photo.isIllustrative && <span>网络示意图</span>}</> : null}
      </div>}
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
