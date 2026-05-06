/** Deduplicate while preserving first-seen order. */
export function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
