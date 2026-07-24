import type { SchemaCompatRule, JsonSchema } from '../types.js';
import { walk, stripStringFormats } from './util.js';

/**
 * Anthropic (Claude) is lenient with tool schemas; a minimal touch is enough:
 * unsupported string `format`/`pattern` → moved into the description, `$schema` is stripped.
 */
export const anthropic: SchemaCompatRule = {
  name: 'anthropic',
  shouldApply: (m) => m.modelId.includes('claude'),
  transform(schema: JsonSchema) {
    walk(schema, (n) => stripStringFormats(n));
    delete schema.$schema;
    return schema;
  },
};
