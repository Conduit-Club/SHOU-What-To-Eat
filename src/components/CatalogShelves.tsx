import CatalogCards from './CatalogCards';
import { newest,recommended,type CatalogCard } from '../utils/catalog-discovery';
export default function CatalogShelves({items,type}:{items:CatalogCard[];type:'food'|'venue'}) {
  const rated=recommended(items).slice(0,4); const recent=newest(items).slice(0,4);
  const noun=type==='food'?'餐品':'餐厅 / 档口';
  return <>
    <section className="catalog-shelf" aria-label={'高评分'+noun}><header className="shelf-heading"><div><h2>同学好评 · {noun}</h2><p>同学吃过，值得一试。</p></div><a href={(type==='food'?'/foods/':'/restaurants/')+'?sort=rating'}>查看评分食单 →</a></header>{rated.length?<CatalogCards items={rated}/>:<div className="shelf-empty"><p>你心中的好味道，值得被更多人发现。</p><a href={type==='food'?'/foods/':'/restaurants/'}>找到吃过的，写一条评价 ＋</a></div>}</section>
    <section className="catalog-shelf" aria-label={'最近收录'+noun}><header className="shelf-heading"><div><h2>最近收录 · {noun}</h2><p>看看大家最近发现了什么。</p></div><a href={(type==='food'?'/foods/':'/restaurants/')+'?sort=newest'}>看看最近加入的 →</a></header>{recent.length?<CatalogCards items={recent}/>:<div className="shelf-empty"><p>新的{noun}正在等你分享。审核发布后，就会出现在这里。</p><a href="/submit/">分享一份新发现 ＋</a></div>}</section>
  </>;
}
