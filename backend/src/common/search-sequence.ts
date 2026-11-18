export function searchSequence(query: string | undefined, prefix: 'DV-' | '#'): number | null {
  if (!query) return null;
  const digits = query.toUpperCase().startsWith(prefix) ? query.slice(prefix.length) : query;
  if (!/^\d+$/.test(digits)) return null;

  const sequence = Number(digits);
  return sequence > 0 && sequence <= 2147483647 ? sequence : null;
}
