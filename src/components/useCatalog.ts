import { useEffect, useState } from 'react';
import type { DiscoveryCatalog } from '../utils/catalog-discovery';
import { loadCatalog } from '../utils/load-catalog';
export function useCatalog(initial:DiscoveryCatalog) {
  const [catalog,setCatalog]=useState(initial);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState<string | null>(null);
  const [revision,setRevision]=useState(0);
  useEffect(()=>{let active=true;let running=false;const refresh=async()=>{if(running)return;running=true;try{const data=await loadCatalog();if(active){setCatalog(data);setError(null);}}catch(cause){if(active)setError(cause instanceof Error && cause.message==='数据库错误，请稍后重试。'?cause.message:'目录暂时无法加载，请稍后重试。');}finally{running=false;if(active)setLoading(false);}};setLoading(true);void refresh();const focus=()=>{if(document.visibilityState==='visible')void refresh();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);return()=>{active=false;window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);};},[revision]);
  return {catalog,loading,error,retry:()=>setRevision(value=>value+1)};
}
