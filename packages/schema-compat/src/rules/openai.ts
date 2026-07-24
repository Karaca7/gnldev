import type { SchemaCompatRule, JsonSchema } from '../types.js';
import { walk, stripStringFormats } from './util.js';

/**
 * OpenAI (and groq) strict / structured-output compatibility:
 *  - every object node gets `additionalProperties:false` + all properties become `required`
 *    (OpenAI strict mode requires this; optionality is represented on the provider side via nullable)
 *  - unsupported string `format`/`pattern` → moved into the description
 *
 * Why: the AI SDK's OpenAI provider silently rejects e.g. a Zod `.url()` (→ format:'uri') schema.
 */
export const openaiStrict: SchemaCompatRule = {
  name: 'openai-strict',
  shouldApply: (m) =>
    m.provider.includes('openai') || m.modelId.includes('openai') || m.provider.includes('groq'),
  transform(schema: JsonSchema) {
    walk(schema, (n) => {
      stripStringFormats(n);
      const isObject = n.type === 'object' || (n.properties && typeof n.properties === 'object');
      if (isObject) {
        n.additionalProperties = false;
        if (n.properties && typeof n.properties === 'object') {
          n.required = Object.keys(n.properties);
        }
      }
    });
    delete schema.$schema;
    return schema;
  },
};
