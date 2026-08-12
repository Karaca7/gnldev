// aiToolSchema — the `@gnldev/studio/ai` bridge the Tools view uses to turn a tool's input schema
// into JSON Schema for form generation. Its contract is "convert, or return undefined" — the catch
// branch is what keeps a weird schema from taking the whole Tools view down, so both halves matter.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { jsonSchema } from 'ai';
import { aiToolSchema } from '../src/ai-schema.js';

describe('aiToolSchema', () => {
  it('converts a zod object schema to JSON Schema (properties + required survive)', () => {
    const schema = z.object({
      city: z.string().describe('City name'),
      days: z.number().int(),
      verbose: z.boolean().optional(),
    });
    const json = aiToolSchema(schema) as any;

    expect(json?.type).toBe('object');
    expect(Object.keys(json.properties)).toEqual(['city', 'days', 'verbose']);
    expect(json.properties.city.type).toBe('string');
    // z.number().int() narrows to JSON Schema `integer`, not `number` — the Tools view renders a
    // step-1 field off this, so the distinction is load-bearing.
    expect(json.properties.days.type).toBe('integer');
    // optional fields must NOT be required — the form would demand a value that the tool doesn't need
    expect(json.required).toContain('city');
    expect(json.required).toContain('days');
    expect(json.required ?? []).not.toContain('verbose');
  });

  it('an empty object schema converts (a tool taking no input still gets a form)', () => {
    const json = aiToolSchema(z.object({})) as any;
    expect(json?.type).toBe('object');
  });

  it('nested objects and arrays are preserved', () => {
    const json = aiToolSchema(
      z.object({ filter: z.object({ tags: z.array(z.string()) }) }),
    ) as any;
    expect(json.properties.filter.type).toBe('object');
    expect(json.properties.filter.properties.tags.type).toBe('array');
  });

  it("an AI SDK Schema (ai's jsonSchema() helper) passes through unchanged", () => {
    const shape = { type: 'object', properties: { q: { type: 'string' } } } as const;
    expect(aiToolSchema(jsonSchema(shape as any))).toEqual(shape);
  });

  it('a BARE JSON-Schema object is NOT accepted — it must be wrapped by jsonSchema()', () => {
    // documents the real contract: asSchema only recognizes zod schemas and AI SDK Schema objects.
    // A caller handing the Tools view a raw JSON Schema gets "no schema", not a form.
    expect(aiToolSchema({ type: 'object', properties: {} })).toBeUndefined();
    expect(aiToolSchema({ jsonSchema: { type: 'object' } })).toBeUndefined();
  });

  it('unconvertible input returns undefined — it must NEVER throw into the Tools view', () => {
    for (const bad of [undefined, null, 42, 'nope', Symbol('x'), () => {}]) {
      expect(() => aiToolSchema(bad)).not.toThrow();
    }
  });

  it('a schema whose conversion throws is swallowed into undefined', () => {
    const exploding = {
      get jsonSchema() {
        throw new Error('boom');
      },
    };
    expect(aiToolSchema(exploding)).toBeUndefined();
  });
});
