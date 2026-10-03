import type { DiscoveryCatalog } from './catalog-discovery';

export async function loadCatalog(): Promise<DiscoveryCatalog> {
  const response = await fetch('/catalog-index.json', { cache: 'no-store' });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    // Only display known public messages, never arbitrary server diagnostics.
    throw new Error(body?.error?.code === 'database_error'
      ? '数据库错误，请稍后重试。'
      : '目录暂时无法加载，请稍后重试。');
  }
  const data = await response.json();
  if (!data || !Array.isArray(data.foods) || !Array.isArray(data.venues)) throw new Error('目录格式无效');
  return data as DiscoveryCatalog;
}
