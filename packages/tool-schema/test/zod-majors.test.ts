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

      it('an open-ended object declared with z.record is NOT usable as a provider schema', () => {
        // This is the break, pinned as the fact it is rather than as a wish. On zod 3 the conversion
        // yields `additionalProperties: {}` (anything allowed); on zod 4, provider-utils forces
        // `additionalProperties: false` — the model is told the object takes NO properties. Neither
        // `z.looseObject({})` nor `z.object({}).passthrough()` escapes it, so there is no zod spelling
        // that works on both. Anything first-party that needs an open object must use jsonSchema().
        const s = emitted(z.object({ input: z.record(z.string(), z.any()) }));
        const ap = s.properties.input.additionalProperties;
        if (name === 'zod4') {
          expect(ap, 'if this stops being false, provider-utils changed and the jsonSchema() workarounds can go').toBe(false);
        } else {
          expect(ap).toEqual({});
        }
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
