export function turnstileWidget(): HTMLElement | null {
  const siteKey = import.meta.env.PUBLIC_TURNSTILE_SITE_KEY;
  if (!siteKey) return null;
  const wrapper = document.createElement('div');
  wrapper.className = 'cf-turnstile';
  wrapper.dataset.sitekey = siteKey;
  const script = document.createElement('script');
  script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  script.async = true;
  document.head.append(script);
  return wrapper;
}
