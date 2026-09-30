const safeImageUrl = (value: string) => {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') && !['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(url.hostname.toLowerCase());
  } catch { return false; }
};

export function validateSubmission(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_submission');
  const input = value as Record<string, unknown>;
  for (const key of ['name', 'location', 'body']) if (typeof input[key] !== 'string' || !input[key].trim()) throw new Error(`invalid_${key}`);
  if ((input.name as string).length > 100 || (input.location as string).length > 300 || (input.body as string).length > 20_000) throw new Error('content_too_long');
  if (!['on-campus', 'off-campus'].includes(String(input.category)) || !['new', 'review', 'correction'].includes(String(input.kind))) throw new Error('invalid_category_or_kind');
  if (input.visitedAt && (typeof input.visitedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.visitedAt) || new Date(`${input.visitedAt}T00:00:00Z`).toISOString().slice(0, 10) !== input.visitedAt || input.visitedAt > new Date().toISOString().slice(0, 10))) throw new Error('invalid_visited_at');
  if (input.imageUrl && (typeof input.imageUrl !== 'string' || !safeImageUrl(input.imageUrl))) throw new Error('invalid_image_url');
  return { type: input.kind as string, targetRestaurantId: typeof input.targetId === 'string' ? input.targetId : null, publicFields: { name: (input.name as string).trim(), location: (input.location as string).trim(), body: (input.body as string).trim(), category: input.category, visitedAt: input.visitedAt || null, imageUrl: input.imageUrl || null } };
}
