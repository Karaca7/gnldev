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
 * and each was added for a reason worth writing down:
 *
 * `provider.includes('openai')` — the direct case.
 * `modelId.includes('openai')` — a gateway reports itself as the provider and puts the real one
 *    inside the model id (`{provider: 'openrouter', modelId: 'openai/gpt-4o'}`). That form is used
 *    throughout this repo, so without this term every gateway-routed OpenAI call would skip the
 *    transform and fail on the first `.url()` in a tool schema.
 * `provider.includes('groq')` — groq serves an OpenAI-compatible API and says so in its own base
 * URL, `https://api.groq.com/openai/v1`. It therefore rejects the same schemas for the same
 *    reason and needs the same treatment. This is not an insight about groq; it is groq's published
 *    description of itself, and any implementation reading that documentation lands here. It is
 *    listed separately only because the provider string a user passes is `'groq'`, not `'openai'`,
 *    so neither term above catches it. Covered by `test/tool-schema.test.ts` ("groq provider is
 *    also caught").
 *
 * Note that groq is not a dependency here and never has been: the term exists so a caller who
 * brings their own groq provider is handled, not because this package integrates one.
 */
/**
 * Widens a schema so it also accepts `null` — the second half of "everything is required".
 *
 * Forcing a key into `required` without this says the model MUST produce a value for a parameter its
 * author marked optional. Measured before this existed: a `z.string().optional()` field came out as
 * `required` with `type:'string'` and no null — the model had no way to say "not supplied", which is
 * A different tool contract than the one that was written.
 *
 * How hard that bites depends on the call. An earlier version of this note claimed the AI SDK's
 * OpenAI provider defaults `strictJsonSchema` to true, so the constraint was always enforced; that is
 * wrong for tool schemas — measured, `strict` is sent only when the tool sets it
 * (`...tool.strict != null ? { strict: tool.strict } : {}`), and the `?? true` default belongs to the
 * structured-output path. Under `strict: true` this is a hard constraint the model cannot satisfy
 * without inventing a value; without it, `required` is still what the model is told the tool wants.
 * Either way the schema described a contract its author did not write.
 *
 * In place where the node's own `type` can carry it; wrapped in `anyOf` when the node is a `$ref`,
 * `enum`, `const`, `oneOf` or `allOf`, none of which can express nullability without changing what
 * they mean. A node with no type constraint at all already permits null and is left untouched.
 */
function allowNull(prop: any): any {
  if (!prop || typeof prop !== 'object') return prop;

  // `const` FIRST, and that order is the fix rather than a detail. A `const` node normally carries a
  // `type` too (zod emits `z.literal('yes')` as `{type:'string', const:'yes'}`), so the type branch
  // below matched it and returned before ever reaching the const check — leaving
  // `{type:['string','null'], const:'yes'}`, whose type admits null while its const forbids it.
  // Nothing satisfies that, which is the same unsatisfiable-node bug this rule fixes for `enum`,
  // surviving one branch away from it. A single permitted value cannot be widened in place the way an
  // enum's list can, so the node is wrapped instead.
  if (prop.const !== undefined) return { anyOf: [prop, { type: 'null' }] };

  if (Array.isArray(prop.type) || typeof prop.type === 'string' || Array.isArray(prop.enum)) {
    // An `enum` restricts the VALUE set, so widening `type` alone would leave a node whose type
    // admits null while its enum still forbids it — unsatisfiable, which is the bug being fixed
    // rather than a narrower version of it. Zod emits `.enum([...]).optional()` in exactly this
    // shape (`{type:'string', enum:[...]}`), so it is the common case, not a corner.
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

/**
 * Collapses an `allOf` of plain objects into the single object it describes.
 *
 * `additionalProperties: false` and `allOf` do not compose: each branch is validated on its own, so
 * `{a,b}` against `allOf: [{a, addl:false}, {b, addl:false}]` fails BOTH — the first rejects `b`, the
 * second rejects `a`. Nothing satisfies it. Measured on `z.intersection(z.object({a}), z.object({b}))`,
 * which is the ordinary way to write this, and the rule below was producing exactly that shape.
 *
 * An intersection of object types IS one object with the union of the properties, so merging is the
 * meaning rather than an approximation — and the result is something OpenAI strict accepts, which an
 * `allOf` is not. Kept conservative: only branches that are plain `properties` objects merge, and a
 * property named in two branches leaves the whole thing alone, because picking a winner would be
 * inventing a schema the author did not write. Anything not merged keeps its `allOf` and simply does
 * not get `additionalProperties` (see the walk), which is at least satisfiable.
 */
function mergeObjectAllOf(node: any): boolean {
  if (!Array.isArray(node?.allOf) || node.allOf.length === 0) return false;
  const plain = (b: any) =>
    b && typeof b === 'object' && b.properties && typeof b.properties === 'object'
    && (b.type === undefined || b.type === 'object')
    && !b.$ref && !b.anyOf && !b.oneOf && !b.allOf && !b.patternProperties && !b.enum && !b.const;
  if (!node.allOf.every(plain)) return false;

  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const b of node.allOf) {
    for (const [k, v] of Object.entries(b.properties as Record<string, unknown>)) {
      if (k in properties) return false; // the same key in two branches — do not choose for the author
      properties[k] = v;
    }
    for (const r of Array.isArray(b.required) ? b.required : []) required.push(r);
  }
  delete node.allOf;
  node.type = 'object';
  node.properties = properties;
  if (required.length) node.required = [...new Set(required)];
  return true;
}

export const openaiStrict: ToolSchemaRule = {
  name: 'openai-strict',
  shouldApply: (m) =>
    m.provider.includes('openai') || m.modelId.includes('openai') || m.provider.includes('groq'),
  transform(schema: JsonSchema) {
    // Two passes, because the second needs an answer the first has to produce: which object nodes are
    // BRANCHES of an `allOf` that could not be merged. `walk` visits a branch on its own and cannot
    // say what contains it, and a branch is exactly where `additionalProperties: false` is fatal —
    // every branch is checked against the same value, so each rejects the other's properties and
    // nothing satisfies the whole. Measured: an `allOf` of a plain object and a `$ref`, with distinct
    // keys, came out impossible to satisfy.
    const inUnmergedAllOf = new WeakSet<object>();
    walk(schema, (n) => {
      if (!Array.isArray((n as any).allOf)) return;
      if (mergeObjectAllOf(n)) return; // became a plain object — the ordinary rules now apply to it
      for (const branch of (n as any).allOf) if (branch && typeof branch === 'object') inUnmergedAllOf.add(branch);
    });

    walk(schema, (n) => {
      stripStringFormats(n);
      const isObject = n.type === 'object' || (n.properties && typeof n.properties === 'object');
      // Two ways `additionalProperties: false` turns an `allOf` schema into an impossible one, and
      // both are excluded here. On a BRANCH it rejects the sibling branches' properties. On the node
      // that CARRIES the allOf it is worse: `additionalProperties` only ever pairs with that node's
      // own `properties`, and a composition node has none — so `{type:'object', allOf:[…],
      // AdditionalProperties:false}` permits no properties at all. A schema that permits too much
      // beats one nothing can satisfy.
      const composes = Array.isArray((n as any).allOf);
      if (isObject && !composes && !inUnmergedAllOf.has(n as object)) {
        n.additionalProperties = false;
        if (n.properties && typeof n.properties === 'object') {
          // Which keys were optional BEFORE this rule makes everything required — read first,
          // because the next statement destroys the answer.
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
