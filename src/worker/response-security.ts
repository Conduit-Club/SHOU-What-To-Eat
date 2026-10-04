/** Also covers ASSETS responses, which can have immutable response headers. */
export function secureResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  const directives = (headers.get('Content-Security-Policy') ?? '').split(';')
    .map(value => value.trim()).filter(value => value && !/^frame-ancestors\b/i.test(value));
  directives.push("frame-ancestors 'none'");
  headers.set('Content-Security-Policy', directives.join('; '));
  headers.set('X-Frame-Options', 'DENY');
  headers.set('X-Content-Type-Options', 'nosniff');
  if (!headers.has('Referrer-Policy')) headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
