/** RFC 9110 GET If-None-Match uses weak comparison. The caller must first
 * establish the current representation from its authoritative version. */
export function ifNoneMatchMatches(requested: string, currentTag: string): boolean {
  const value = requested.replace(/^[ \t]+|[ \t]+$/g, '');
  if (value === '*') return true;
  const current = currentTag.replace(/^W\//, '');
  const token = /(?:W\/)?("[\x21\x23-\x7e\x80-\xff]*")/y;
  let index = 0, matched = false;
  while (index < value.length) {
    // List recipients tolerate empty members. Commas inside opaque tags are
    // consumed by the quoted token, never interpreted as list separators.
    while (index < value.length && /[ \t,]/.test(value[index])) index++;
    if (index === value.length) break;
    token.lastIndex = index;
    const item = token.exec(value);
    if (!item) return false;
    if (item[1] === current) matched = true;
    index = token.lastIndex;
    while (index < value.length && /[ \t]/.test(value[index])) index++;
    if (index < value.length && value[index] !== ',') return false;
  }
  // Do not accept a matching token embedded in an otherwise invalid field.
  return matched;
}
