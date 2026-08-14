import type { ToolSchemaRule, JsonSchema } from '../types.js';
import { walk, stripStringFormats } from './util.js';

/**
 * Anthropic (Claude) is lenient with tool schemas; a minimal touch is enough:
 * Unsupported string `format`/`pattern` → moved into the description, `$schema` is stripped.
 */
export const anthropic: ToolSchemaRule = {
  name: 'anthropic',
  shouldApply: (m) => m.modelId.includes('claude'),
  transform(schema: JsonSchema) {
    walk(schema, (n) => stripStringFormats(n));
    delete schema.$schema;
    return schema;
  },
};
