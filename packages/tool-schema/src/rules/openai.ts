import type { ToolSchemaRule, JsonSchema } from '../types.js';
import { walk, stripStringFormats } from './util.js';

/**
 * OpenAI (and groq) strict / structured-output compatibility:
 * every object node gets `additionalProperties:false` + all properties become `required`, and a
 *    Property that WAS optional is widened to accept `null` so it stays optional in effect — strict
 *    Mode has no other way to express it (see `allowNull`)
 * unsupported string `format`/`pattern` → moved into the description
 *
 * Why: the AI SDK's OpenAI provider silently rejects e.g. a Zod `.url()` (→ format:'uri') schema.
 *
 * The predicate has three terms because a request can arrive naming the provider in three places,
 * And each was added for a reason worth writing down:
 *
 * `provider.includes('openai')` — the direct case.
 * `modelId.includes('openai')` — a gateway reports itself as the provider and puts the real one
 *    Inside the model id (`{provider: 'openrouter', modelId: 'openai/gpt-4o'}`). That form is used
 *    Throughout this repo, so without this term every gateway-routed OpenAI call would skip the
 *    Transform and fail on the first `.url()` in a tool schema.
 * `provider.includes('groq')` — groq serves an OpenAI-compatible API and says so in its own base
 * URL, `https://api.groq.com/openai/v1`. It therefore rejects the same schemas for the same
 *    Reason and needs the same treatment. This is not an insight about groq; it is groq's published
 *    Description of itself, and any implementation reading that documentation lands here. It is
 *    Listed separately only because the provider string a user passes is `'groq'`, not `'openai'`,
 *    So neither term above catches it. Covered by `test/tool-schema.test.ts` ("groq provider is
 *    Also caught").
 *
 * Note that groq is not a dependency here and never has been: the term exists so a caller who
 * Brings their own groq provider is handled, not because this package integrates one.
 */
/**
 * Widens a schema so it also accepts `null` — the second half of "everything is required".
 *
 * Forcing a key into `required` without this says the model MUST produce a value for a parameter its
 * Author marked optional. Measured before this existed: a `z.string().optional()` field came out as
 * `required` with `type:'string'` and no null — the model had no way to say "not supplied", which is
 * A different tool contract than the one that was written.
 *
 * How hard that bites depends on the call. An earlier version of this note claimed the AI SDK's
 * OpenAI provider defaults `strictJsonSchema` to true, so the constraint was always enforced; that is
 * Wrong for tool schemas — measured, `strict` is sent only when the tool sets it
 * (`...tool.strict != null ? { strict: tool.strict } : {}`), and the `?? true` default belongs to the
 * Structured-output path. Under `strict: true` this is a hard constraint the model cannot satisfy
 * Without inventing a value; without it, `required` is still what the model is told the tool wants.
 * Either way the schema described a contract its author did not write.
 *
 * In place where the node's own `type` can carry it; wrapped in `anyOf` when the node is a `$ref`,
 * `enum`, `const`, `oneOf` or `allOf`, none of which can express nullability without changing what
 * They mean. A node with no type constraint at all already permits null and is left untouched.
 */
function allowNull(prop: any): any {
  if (!prop || typeof prop !== 'object') return prop;

  // `const` FIRST, and that order is the fix rather than a detail. A `const` node normally carries a
  // `type` too (zod emits `z.literal('yes')` as `{type:'string', const:'yes'}`), so the type branch
  // Below matched it and returned before ever reaching the const check — leaving
  // `{type:['string','null'], const:'yes'}`, whose type admits null while its const forbids it.
  // Nothing satisfies that, which is the same unsatisfiable-node bug this rule fixes for `enum`,
  // Surviving one branch away from it. A single permitted value cannot be widened in place the way an
  // Enum's list can, so the node is wrapped instead.
  if (prop.const !== undefined) return { anyOf: [prop, { type: 'null' }] };

  if (Array.isArray(prop.type) || typeof prop.type === 'string' || Array.isArray(prop.enum)) {
    // An `enum` restricts the VALUE set, so widening `type` alone would leave a node whose type
    // Admits null while its enum still forbids it — unsatisfiable, which is the bug being fixed
    // Rather than a narrower version of it. Zod emits `.enum([...]).optional()` in exactly this
    // Shape (`{type:'string', enum:[...]}`), so it is the common case, not a corner.
    if (Array.isArray(prop.enum) && !prop.enum.includes(null)) prop.enum = [...prop.enum, null];
    if (Array.isArray(prop.type)) {
      if (!prop.type.includes('null')) prop.type = [...prop.type, 'null'];
    } else if (typeof prop.type === 'string' && prop.type !== 'null') {
      prop.type = [prop.type, 'null'];
    }
    return prop;
  }
  if (Array.isArray(prop.anyOf)) {
    if (!prop.anyOf.some((s: any) => s?.type === 'null')) prop.anyOf = [...prop.anyOf, { type: 'null' }];
    return prop;
  }
  const constrained = prop.$ref !== undefined || Array.isArray(prop.oneOf) || Array.isArray(prop.allOf);
  return constrained ? { anyOf: [prop, { type: 'null' }] } : prop;
}

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
          // Which keys were optional BEFORE this rule makes everything required — read first,
          // Because the next statement destroys the answer.
          const optional = new Set(Object.keys(n.properties));
          for (const k of Array.isArray(n.required) ? n.required : []) optional.delete(k);
          for (const k of optional) (n.properties as any)[k] = allowNull((n.properties as any)[k]);
          n.required = Object.keys(n.properties);
        }
      }
    });
    delete schema.$schema;
    return schema;
  },
};
