// Working memory deep-merge (common working-memory semantics): objects merge recursively, array/scalar values are replaced,
// A `null` value DELETES the corresponding key.
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export function deepMerge(existing: unknown, update: unknown): Record<string, unknown> {
  if (!isObj(existing) || !isObj(update)) return (isObj(update) ? update : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...existing };
  for (const [k, v] of Object.entries(update)) {
    if (v === null) delete out[k];
    else if (isObj(v) && isObj(out[k])) out[k] = deepMerge(out[k], v);
    else out[k] = v;
  }
  return out;
}
