export function turnstileWidget(): HTMLElement | null {
  const siteKey = String(import.meta.env.PUBLIC_TURNSTILE_SITE_KEY ?? '').trim();
  if (!siteKey) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'cf-turnstile';
  wrapper.dataset.sitekey = siteKey;
  wrapper.dataset.action = 'submission';
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
