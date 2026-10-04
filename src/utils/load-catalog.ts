import type { DiscoveryCatalog } from './catalog-discovery';

type CatalogRequest = { data?: DiscoveryCatalog; etag?: string; pending?: Promise<DiscoveryCatalog> };
const requests = new WeakMap<typeof fetch, CatalogRequest>();

/** Every refresh reaches the server. Previously validated public data is reused
 * only after the Worker checks its current authoritative revision and sends 304. */
export function loadCatalog(send: typeof fetch = fetch): Promise<DiscoveryCatalog> {
  const cache = requests.get(send) ?? {};
  requests.set(send, cache);
  if (cache.pending) return cache.pending;
  const previous = cache.data, etag = previous ? cache.etag : undefined;
  const pending = (async () => {
    const response = await send('/catalog-index.json', { cache: 'no-store', ...(etag ? { headers: { 'If-None-Match': etag } } : {}) });
    if (response.status === 304 && previous && etag) return previous;
    if (!response.ok) {
      const body = await response.json().catch(() => null);
      // Only display known public messages, never arbitrary server diagnostics.
      throw new Error(body?.error?.code === 'database_error'
        ? '数据库错误，请稍后重试。'
        : '目录暂时无法加载，请稍后重试。');
    }
    const data = await response.json();
    if (!data || !Array.isArray(data.foods) || !Array.isArray(data.venues)) throw new Error('目录格式无效');
    cache.data = data as DiscoveryCatalog;
    cache.etag = response.headers.get('ETag') ?? undefined;
    return cache.data;
  })();
  cache.pending = pending;
  const clear = () => { if (cache.pending === pending) delete cache.pending; };
  void pending.then(clear, clear);
  return pending;
}
