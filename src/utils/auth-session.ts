export type AccountSession = {
  configured: boolean;
  directPublishing?: boolean;
  user: { username: string; picture: string | null; isAdmin: boolean; wasAdmin: boolean; adminExpiresAt: number; expiresAt: number } | null;
  csrfToken: string | null;
};

const pendingSessions = new WeakMap<typeof fetch, Promise<AccountSession>>();

/** Share concurrent display refreshes only; writes always request a fresh CSRF
 * token. No account response survives completion as a cached session. */
export function fetchAccountSession(send: typeof fetch = fetch, fresh = false): Promise<AccountSession> {
  const pending = !fresh && pendingSessions.get(send);
  if (pending) return pending;
  const request = (async () => {
    const response = await send('/auth/session', { cache: 'no-store', credentials: 'same-origin' });
    if (!response.ok) throw new Error('账号状态暂时无法加载，请稍后重试。');
    return response.json() as Promise<AccountSession>;
  })();
  if (!fresh) {
    pendingSessions.set(send, request);
    const clear = () => { if (pendingSessions.get(send) === request) pendingSessions.delete(send); };
    void request.then(clear, clear);
  }
  return request;
}

export function loginHref(path = location.pathname + location.search + location.hash): string {
  return '/auth/login?' + new URLSearchParams({ returnTo: path });
}

export function adminApiBase(path = location.pathname): string {
  return path.startsWith('/admin') ? '/api/v2/admin' : '/api/manage/v2';
}

export class AdminRequestError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) { super(message); }
}

export async function adminRequest(path: string, init: RequestInit = {}, send: typeof fetch = fetch, base = adminApiBase()) {
  const headers = new Headers(init.headers);
  headers.set('Content-Type', 'application/json');
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) {
    // Acquire the current CSRF token after a renewal in another tab. The
    // Worker alone decides whether this cookie or a verified Access JWT grants
    // admin rights, and always checks cookie-authenticated writes.
    const session = await fetchAccountSession(send, true);
    if (session.csrfToken) headers.set('X-CSRF-Token', session.csrfToken);
  }
  const response = await send(base + path, { ...init, cache: 'no-store', credentials: 'same-origin', headers });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data) throw new AdminRequestError(data?.error?.message ?? '审核会话可能已到期，请重新登录或刷新。', response.status, data?.error?.code ?? 'request_failed');
  return data;
}
