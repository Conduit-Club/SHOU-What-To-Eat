/** Campus dining dates follow UTC+8, independently of the browser or Worker timezone. */
export function diningDate(timestamp = Date.now()): string {
  return new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}
