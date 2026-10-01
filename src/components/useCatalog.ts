import { useEffect, useState } from 'react';
import type { DiscoveryCatalog } from '../utils/catalog-discovery';
let loadingCatalog: Promise<DiscoveryCatalog> | null = null;
async function loadCatalog() {
  const response=await fetch('/catalog-index.json');
  if(!response.ok)throw new Error('目录暂时无法加载');
  const data=await response.json();
  if(!data || !Array.isArray(data.foods) || !Array.isArray(data.venues))throw new Error('目录格式无效');
  return data as DiscoveryCatalog;
}
export function useCatalog(initial:DiscoveryCatalog) {
  const [catalog,setCatalog]=useState(initial);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(false);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{let active=true;setLoading(true);setError(false);loadingCatalog??=loadCatalog();loadingCatalog.then(data=>{if(active)setCatalog(data);}).catch(()=>{loadingCatalog=null;if(active)setError(true);}).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[revision]);
  return {catalog,loading,error,retry:()=>setRevision(value=>value+1)};
}
