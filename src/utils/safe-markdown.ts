const HTML_ESCAPE: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => HTML_ESCAPE[character]!);
}

export function safeExternalUrl(raw: string) {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && !url.username && !url.password && !['localhost', '127.0.0.1', '::1'].includes(url.hostname.toLowerCase()) && !/^(10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(url.hostname);
  } catch {
    return false;
  }
}

export function renderSafeMarkdown(source: string) {
  return source.split('\n').map((line) => {
    const parts: string[] = [];
    let cursor = 0;
    const inline = /!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)|\[([^\]]+)\]\((https:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`/g;
    for (const match of line.matchAll(inline)) {
      const index = match.index ?? cursor;
      parts.push(escapeHtml(line.slice(cursor, index)));
      if (match[1] !== undefined && match[2] !== undefined) {
        const alt = match[1];
        const url = match[2];
        parts.push(safeExternalUrl(url) ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" referrerpolicy="no-referrer">` : escapeHtml(alt));
      } else if (match[3] !== undefined && match[4] !== undefined) {
        const label = match[3];
        const url = match[4];
        parts.push(safeExternalUrl(url) ? `<a href="${escapeHtml(url)}" rel="nofollow noreferrer">${escapeHtml(label)}</a>` : escapeHtml(label));
      } else if (match[5] !== undefined) {
        parts.push(`<strong>${escapeHtml(match[5])}</strong>`);
      } else if (match[6] !== undefined) {
        parts.push(`<code>${escapeHtml(match[6])}</code>`);
      }
      cursor = index + match[0].length;
    }
    parts.push(escapeHtml(line.slice(cursor)));
    return parts.join('');
  }).join('<br>');
}
