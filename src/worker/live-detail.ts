import { html } from 'hono/html';
import { readPublicDetail } from './public-detail.js';
import { formatPrice,formatLocation,safePublicImage,safePublicLink,tagLabel,mealLabel } from '../utils/catalog-display.js';
import type { AppEnv } from './types.js';
import { reviewIdentity } from '../utils/review-identity.js';
import type { Venue } from '../lib/catalog/index.js';

const credit=(image:any)=>html`${image.isIllustrative?'网络示意图 · ':''}${image.author??'作者待补充'} · ${image.license??'授权信息待补充'} ${safePublicLink(image.sourceUrl)?html`<a href="${image.sourceUrl}" target="_blank" rel="noreferrer">来源 ↗</a>`:''}`;
const gallery=(images:any[])=>html`<div class="live-gallery">${images.filter(safePublicImage).map(image=>html`<figure><a href="${image.url}" target="_blank" rel="noreferrer"><img loading="lazy" src="${image.url}" alt="${image.alt}" /></a><figcaption>${credit(image)}</figcaption></figure>`)}</div>`;
export const reviewAuthor = (review: { authorAlias?: string | null; authorAvatar?: string | null }) => {
  const author = reviewIdentity(review);
  return html`<div class="review-author"><span class="review-author-avatar" aria-hidden="true"><span>${author.initial}</span>${author.picture ? html`<img data-review-avatar src="${author.picture}" alt="" width="36" height="36" loading="lazy" referrerpolicy="no-referrer" />` : ''}</span><strong>${author.name}</strong></div>`;
};
export async function liveDetail(request:Request,env:AppEnv['Bindings'],type:'food'|'venue',id:string){
  const {record,state,reviews,venue:foodVenue,foods}=await readPublicDetail(env.DB,type,id);
  if(!record)return new Response('内容不存在或已下架',{status:404,headers:{'Content-Type':'text/plain; charset=utf-8','Cache-Control':'no-store'}});
  const venue=type==='food'?foodVenue:record as Venue;
  const rated=reviews.filter(r=>r.rating!==null);
  const average=rated.length?(rated.reduce((n,r)=>n+r.rating!,0)/rated.length).toFixed(1):null;
  const images=record.images.filter(safePublicImage),first=images[0];
  const price='price' in record?record.price:record.averagePrice;
  const body=await html`<div class="live-breadcrumb"><a href="${type==='food'?'/foods/':'/restaurants/'}">← 返回${type==='food'?'餐品':'店铺'}目录</a><a href="#review-form">写评价 ＋</a></div>
  <section class="live-hero ${first?'':'without-photo'}">${first?html`<figure class="live-cover">${first?html`<img src="${first.url}" alt="${first.alt}" style="object-position:${(first as typeof first & {position?:{x:number;y:number}}).position?.x??50}% ${(first as typeof first & {position?:{x:number;y:number}}).position?.y??50}%" /><figcaption>${credit(first)}</figcaption>`:html`<a class="live-placeholder" href="#review-form">分享实拍或菜单 ＋</a>`}</figure>`:''}
  <div class="live-info"><span>${venue?.category==='on-campus'?'校内':'校外'} · ${average?`${average} 分 / ${rated.length} 条评分`:'暂未评分'}</span><h1>${record.name}</h1>${venue?html`<a href="/restaurants/${venue.id}/">${venue.name} · ${formatLocation(venue.location)} ↗</a>`:''}<p class="live-price">${formatPrice('price' in record?record.price:'averagePrice' in record?record.averagePrice:null)}</p><div class="live-tags">${[...('mealTypes' in record?record.mealTypes.map(mealLabel):[]),...record.tags.map(tagLabel)].map(tag=>html`<span>${tag}</span>`)}</div>${record.description?html`<p>${record.description}</p>`:''}${'openingHours' in record&&record.openingHours?html`<p>营业时间：${record.openingHours}</p>`:''}</div></section>
  ${price?html`<p class="live-source">价格来源：${price.source??'待补充'} · 核验日期：${price.verifiedAt??'未知，以现场为准'}</p>`:''}
  ${images.length>1?html`<section class="live-section"><h2>更多照片</h2>${gallery(images.slice(1))}</section>`:''}
  ${type==='venue'?html`<section class="live-section"><h2>店内餐品</h2><div class="live-food-links">${foods.map(f=>html`<a href="/foods/${f.id}/"><strong>${f.name}</strong> · ${formatPrice(f.price)} ↗</a>`)}</div></section>`:''}
  <section class="live-section"><h2>同学评价 · ${reviews.length}</h2>${!reviews.length?html`<p>还没有同学评价，吃过后留下你的感受吧。</p>`:html`<div class="live-reviews">${reviews.map(r=>html`<article class="live-review">${reviewAuthor(r)}<p class="live-stars" aria-label="${r.rating===null?'未评分':`${r.rating} 星`}">${r.rating===null?'文字评价':'★'.repeat(r.rating)+'☆'.repeat(5-r.rating)}</p><p>${r.text}</p>${gallery(r.images)}<small>${r.visitedAt?`用餐日期 ${r.visitedAt}`:'用餐日期未注明'}</small></article>`)}</div>`}</section>
  <section class="live-section live-source"><h2>信息来源</h2>${record.sources.map(s=>html`<p>${s.repository} · ${s.path} · ${s.license??'许可未注明'} ${safePublicLink(s.sourceUrl)?html`<a href="${s.sourceUrl}">来源 ↗</a>`:''}</p>`)}</section>`;
  const shell=await env.ASSETS.fetch(new Request(new URL('/live-detail/',request.url),{method:'GET'}));
  const response=new HTMLRewriter()
    .on('title',{element(e){e.setInnerContent(`${record.name} · 今日海大吃什么`);}})
    .on('#live-detail-content',{element(e){e.setAttribute('data-revision',String(state.revision));e.setInnerContent(body,{html:true});}})
    .on('[data-quick-review]',{element(e){e.setAttribute('data-target-type',type);e.setAttribute('data-target-id',id);e.setAttribute('data-target-name',record.name);e.setAttribute('data-snapshot-id','current');}})
    .on('.quick-heading>div>span',{element(e){e.setInnerContent(`${type==='venue'?'欢迎分享店铺体验或上传菜单照片。':`给「${record.name}」留一点真实的感受。`}`);}})
    .transform(shell);
  const headers=new Headers(response.headers);headers.set('Cache-Control','no-store');headers.delete('ETag');
  return new Response(response.body,{status:200,headers});
}
