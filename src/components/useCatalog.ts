import { useEffect, useState } from 'react';
import type { DiscoveryCatalog } from '../utils/catalog-discovery';
async function loadCatalog() {
  const response=await fetch('/catalog-index.json',{cache:'no-store'});
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
  useEffect(()=>{let active=true;let running=false;const refresh=async()=>{if(running)return;running=true;try{const data=await loadCatalog();if(active){setCatalog(data);setError(false);}}catch{if(active)setError(true);}finally{running=false;if(active)setLoading(false);}};setLoading(true);void refresh();const focus=()=>{if(document.visibilityState==='visible')void refresh();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);return()=>{active=false;window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};},[revision]);
  return {catalog,loading,error,retry:()=>setRevision(value=>value+1)};
}
