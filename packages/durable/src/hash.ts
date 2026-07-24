import { createHash } from 'node:crypto';

/** Deterministic JSON, independent of key order. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return Object.keys(obj)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeys(obj[key]);
        return acc;
      }, {});
  }
  return value;
}

/** Secondary integrity signature of tool arguments (the primary key is toolCallId). */
export function argsHash(args: unknown): string {
  return createHash('sha256').update(stableStringify(args)).digest('hex').slice(0, 16);
}
