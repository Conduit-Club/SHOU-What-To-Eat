/** Classify D1 failures without exposing SQL, bindings or private data. */
export function isDatabaseError(error: unknown): boolean {
  const seen = new Set<unknown>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (/^D1_(?:ERROR|EXEC_ERROR|TYPE_ERROR)(?::|\b)/.test(error.message)) return true;
    error = error.cause;
  }
  return false;
}
