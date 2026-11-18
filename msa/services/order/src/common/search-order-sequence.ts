export function searchOrderSequence(query: string | undefined): number | null {
  if (!query) return null;
  const digits = query.toUpperCase().startsWith('DV-') ? query.slice(3) : query;
  if (!/^\d+$/.test(digits)) return null;

  const sequence = Number(digits);
  return sequence > 0 && sequence <= 2147483647 ? sequence : null;
}
