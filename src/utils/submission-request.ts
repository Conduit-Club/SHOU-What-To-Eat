import { fetchAccountSession } from './auth-session';

/** Cookie-authenticated contributions use the current session's CSRF token.
 * An account-service failure must never silently turn an intended direct post
 * into an anonymous submission waiting for moderation. */
export async function submissionFetch(path: string, init: RequestInit = {}, send: typeof fetch = fetch) {
  const headers = new Headers(init.headers);
  if (!['GET', 'HEAD', 'OPTIONS'].includes((init.method ?? 'GET').toUpperCase())) {
    const session = await fetchAccountSession(send, true);
    if (session.csrfToken) headers.set('X-CSRF-Token', session.csrfToken);
  }
  return send(path, { ...init, cache: 'no-store', credentials: 'same-origin', headers });
}

export const isPublished = (status: unknown) => status === 'published' || status === 'deployed';
