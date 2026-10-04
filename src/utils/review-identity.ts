export const AUTH_PROFILE_ORIGIN = 'https://auth.shoumc.com';

/** Public profile snapshots contain no subject, user ID, email or arbitrary image URL. */
export function publicAvatar(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2000) return null;
  try {
    const url = new URL(value);
    return url.origin === AUTH_PROFILE_ORIGIN && !url.username && !url.password && !url.search && !url.hash
      && /^\/api\/profile\/avatar\/[a-f0-9]{64}\.png$/.test(url.pathname) ? url.href : null;
  } catch { return null; }
}

export function reviewIdentity(review: { authorAlias?: string | null; authorAvatar?: string | null }) {
  const name = review.authorAlias?.trim() || '匿名同学';
  const picture = review.authorAlias?.trim() ? publicAvatar(review.authorAvatar) : null;
  return { name, picture, initial: Array.from(name)[0] };
}

export function initReviewAvatars(root: ParentNode = document) {
  root.querySelectorAll<HTMLImageElement>('[data-review-avatar]').forEach(image => {
    const fallback = () => { image.hidden = true; image.removeAttribute('src'); };
    image.addEventListener('error', fallback);
    if (!publicAvatar(image.getAttribute('src')) || (image.complete && image.naturalWidth === 0)) fallback();
  });
}
