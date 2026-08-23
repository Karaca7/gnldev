// The peer range says zod 3 OR zod 4. Only one of them was ever installed.
//
// Widening the range to `^3.25.76 || ^4.1.8` (to match ai@7's own peer) was a manifest change with no
// test behind it: this repo dev-installs zod 3, so every one of the ~2400 tests exercised zod 3 and
// the other half of the claim was never run. It was not idle worry — measuring it found a real break
// on the zod 4 path, where @ai-sdk/provider-utils forces `additionalProperties: false` on converted
// objects and told the model a workflow input accepts nothing.
//
// So zod 4 is installed alongside, under the alias `zod4`, and the conversions that matter are
// asserted under BOTH majors. What is asserted is the JSON Schema the PROVIDER receives — the value
// that actually reaches a model — not our own intermediate shapes.
import { describe, it, expect } from 'vitest';
import { asSchema, jsonSchema } from 'ai';
import { z as z3 } from 'zod';
import { z as z4 } from 'zod4';

const MAJORS = [
  ['zod3', z3 as unknown as typeof z3],
  ['zod4', z4 as unknown as typeof z3],
] as const;

/** The provider-facing JSON Schema for a tool whose input is `s`. */
const emitted = (s: unknown) => asSchema(s as never).jsonSchema as Record<string, any>;

describe('tool schemas under both zod majors', () => {
  it('both majors are actually installed — otherwise this file proves nothing', () => {
    // A version-parameterised suite that silently runs one version twice is worse than no suite: it
    // reports coverage it does not have. Pin that the two are different majors.
    const v3 = (z3 as unknown as { version?: string }).version;
    void v3;
    expect(z3).not.toBe(z4);
    // `z.looseObject` exists only on zod 4 — a cheap, behavioural way to tell them apart.
    expect(typeof (z4 as unknown as { looseObject?: unknown }).looseObject).toBe('function');
    expect(typeof (z3 as unknown as { looseObject?: unknown }).looseObject).toBe('undefined');
  });

  for (const [name, z] of MAJORS) {
    describe(name, () => {
      it('a plain object schema survives the conversion', () => {
        const s = emitted(z.object({ amount: z.number(), note: z.string().optional() }));
        expect(s.type).toBe('object');
        expect(s.properties.amount.type).toBe('number');
        expect(s.required).toContain('amount');
        expect(s.required ?? []).not.toContain('note');
      });

      it('an enum reaches the provider as an enum, not as a bare string', () => {
        const s = emitted(z.object({ mode: z.enum(['fast', 'careful']) }));
        expect(s.properties.mode.enum).toEqual(['fast', 'careful']);
      });

      it('a nested object keeps its shape', () => {
        const s = emitted(z.object({ order: z.object({ id: z.string(), qty: z.number() }) }));
        expect(s.properties.order.type).toBe('object');
        expect(s.properties.order.properties.id.type).toBe('string');
      });

      it('an open-ended object declared with z.record reaches the provider as open on both majors', () => {
        // This assertion used to say the opposite for zod 4, and the change is upstream, not ours.
        // provider-utils forced `additionalProperties: false` on a converted record — the model was
        // told an open object takes NO properties — and neither `z.looseObject({})` nor
        // `z.object({}).passthrough()` escaped it. It is fixed: measured `false` on
        // @ai-sdk/provider-utils 5.0.27 and `{}` on 5.0.29, which is what zod 3 always produced.
        //
        // Found by a fresh install rather than by reading a changelog: this repo's lockfile pinned the
        // older resolution, so the suite had been green against versions a new user would not get. The
        // refreshed lockfile moved 147 of 656 packages and this was the ONLY behavioural difference in
        // 3581 tests.
        //
        // The jsonSchema() escape hatches (registry.ts, mcp, tool-schema/apply.ts) STAY. The declared
        // peer is `ai: ^7.0.0`, so an install can still resolve a version with the old behaviour, and
        // the hatch is correct under both. Deleting it would trade a working path for a version bound
        // this package does not declare.
        const s = emitted(z.object({ input: z.record(z.string(), z.any()) }));
        expect(s.properties.input.additionalProperties,
          'a converted record must not tell the model the object is closed').toEqual({});
      });

      it('jsonSchema() is the escape hatch, and it is identical on both majors', () => {
        // What registry.ts uses for the workflow tool, for exactly this reason.
        const s = emitted(jsonSchema({
          type: 'object',
          properties: { input: { type: 'object', additionalProperties: true } },
        }));
        expect(s.properties.input.additionalProperties).toBe(true);
        expect(JSON.stringify(s)).not.toContain('propertyNames'); // zod 4's record fingerprint
      });
    });
  }
});
