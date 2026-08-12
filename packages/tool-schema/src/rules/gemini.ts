import type { ToolSchemaRule, JsonSchema } from '../types.js';
import { walk, stripStringFormats } from './util.js';

/**
 * Gemini accepts an OpenAPI 3.0 subset, not full JSON Schema:
 *  - `$schema` and `additionalProperties` keywords are stripped (rejected)
 *  - unsupported string `format`/`pattern` → moved into the description
 *  - `oneOf` → `anyOf` (oneOf is not supported)
 *  - `type: [..., 'null']` → `nullable: true` + single type (union-with-null OpenAPI form)
 */
export const gemini: ToolSchemaRule = {
  name: 'gemini',
  shouldApply: (m) => m.provider.includes('google') || m.modelId.includes('gemini'),
  transform(schema: JsonSchema) {
    walk(schema, (n) => {
      stripStringFormats(n);
      delete n.$schema;
      delete n.additionalProperties;
      if (Array.isArray(n.oneOf)) {
        n.anyOf = n.oneOf;
        delete n.oneOf;
      }
      if (Array.isArray(n.type)) {
        const nonNull = n.type.filter((t: unknown) => t !== 'null');
        if (n.type.includes('null')) n.nullable = true;
        n.type = nonNull.length === 1 ? nonNull[0] : nonNull;
      }
    });
    delete schema.$schema;
    return schema;
  },
};
