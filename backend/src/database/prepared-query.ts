import { createHash } from 'node:crypto';

// Only query text enters the per-connection statement name; values stay parameterized.
export function preparedQuery(text: string, values?: unknown[]) {
  return {
    name: 'ai_' + createHash('sha256').update(text).digest('hex').slice(0, 56),
    text,
    values,
  };
}
