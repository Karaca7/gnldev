import type { JsonSchema } from '../types.js';

/**
 * Deeply visits every sub-schema node; `fn` may mutate each node in place.
 * Descends into properties / items / anyOf / oneOf / allOf / additionalProperties / $defs / definitions.
 */
export function walk(node: any, fn: (n: JsonSchema) => void): void {
  if (!node || typeof node !== 'object') return;
  fn(node);
  if (node.properties && typeof node.properties === 'object') {
    for (const k of Object.keys(node.properties)) walk(node.properties[k], fn);
  }
  if (node.items) {
    if (Array.isArray(node.items)) for (const it of node.items) walk(it, fn);
    else walk(node.items, fn);
  }
  for (const key of ['anyOf', 'oneOf', 'allOf'] as const) {
    if (Array.isArray(node[key])) for (const s of node[key]) walk(s, fn);
  }
  if (node.additionalProperties && typeof node.additionalProperties === 'object') {
    walk(node.additionalProperties, fn);
  }
  for (const defKey of ['$defs', 'definitions'] as const) {
    if (node[defKey] && typeof node[defKey] === 'object') {
      for (const k of Object.keys(node[defKey])) walk(node[defKey][k], fn);
    }
  }
}

// String `format`s that many providers reject / ignore in tool schemas.
const STRING_FORMATS = new Set([
  'uri', 'uri-reference', 'url', 'email', 'uuid', 'hostname',
  'ipv4', 'ipv6', 'date-time', 'date', 'time', 'duration', 'regex',
]);

/**
 * Moves unsupported `format`/`pattern` constraints on a string node into the DESCRIPTION and strips them from the schema.
 * This way the meaning (human/cost-readable) is PRESERVED but the provider doesn't reject the schema.
 */
export function stripStringFormats(node: JsonSchema): void {
  const isString = node.type === 'string' || (Array.isArray(node.type) && node.type.includes('string'));
  if (!isString) return;
  const notes: string[] = [];
  if (typeof node.format === 'string' && STRING_FORMATS.has(node.format)) {
    notes.push(`format: ${node.format}`);
    delete node.format;
  }
  if (typeof node.pattern === 'string') {
    notes.push(`pattern: ${node.pattern}`);
    delete node.pattern;
  }
  if (notes.length) {
    node.description = [node.description, `(${notes.join(', ')})`].filter(Boolean).join(' ');
  }
}
