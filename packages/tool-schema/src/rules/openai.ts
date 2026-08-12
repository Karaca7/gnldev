import type { ToolSchemaRule, JsonSchema } from '../types.js';
import { walk, stripStringFormats } from './util.js';

/**
 * OpenAI (and groq) strict / structured-output compatibility:
 *  - every object node gets `additionalProperties:false` + all properties become `required`
 *    (OpenAI strict mode requires this; optionality is represented on the provider side via nullable)
 *  - unsupported string `format`/`pattern` → moved into the description
 *
 * Why: the AI SDK's OpenAI provider silently rejects e.g. a Zod `.url()` (→ format:'uri') schema.
 *
 * The predicate has three terms because a request can arrive naming the provider in three places,
 * and each was added for a reason worth writing down:
 *
 *  - `provider.includes('openai')` — the direct case.
 *  - `modelId.includes('openai')` — a gateway reports itself as the provider and puts the real one
 *    inside the model id (`{provider: 'openrouter', modelId: 'openai/gpt-4o'}`). That form is used
 *    throughout this repo, so without this term every gateway-routed OpenAI call would skip the
 *    transform and fail on the first `.url()` in a tool schema.
 *  - `provider.includes('groq')` — groq serves an OpenAI-compatible API and says so in its own base
 *    URL, `https://api.groq.com/openai/v1`. It therefore rejects the same schemas for the same
 *    reason and needs the same treatment. This is not an insight about groq; it is groq's published
 *    description of itself, and any implementation reading that documentation lands here. It is
 *    listed separately only because the provider string a user passes is `'groq'`, not `'openai'`,
 *    so neither term above catches it. Covered by `test/tool-schema.test.ts` ("groq provider is
 *    also caught").
 *
 * Note that groq is not a dependency here and never has been: the term exists so a caller who
 * brings their own groq provider is handled, not because this package integrates one.
 */
export const openaiStrict: ToolSchemaRule = {
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
