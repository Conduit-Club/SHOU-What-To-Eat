export function turnstileWidget(): HTMLElement | null {
  const siteKey = String(import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();
  if (!siteKey) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'cf-turnstile';
  wrapper.dataset.sitekey = siteKey;
  wrapper.dataset.action = 'submission';
  wrapper.dataset.size = window.matchMedia('(max-width: 400px)').matches ? 'compact' : 'flexible';
  wrapper.dataset.theme = 'light';
  wrapper.setAttribute('aria-label', '人机验证');
  if (!document.querySelector('script[data-turnstile-api]')) {
    const script = document.createElement('script');
    script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
    script.async = true;
    script.dataset.turnstileApi = 'true';
    document.head.append(script);
  }
  return wrapper;
}

/** Pages contain one challenge. Reset it after a consumed or expired token. */
export function resetTurnstile() {
  const api = (window as Window & { turnstile?: { reset: () => void } }).turnstile;
  api?.reset();
}
