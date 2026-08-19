// @gnldev/tool-schema — detect + default rules + applyToolCompat pipeline.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool, jsonSchema } from 'ai';
import {
  detectModel,
  applyToolCompat,
  defaultRules,
  type ToolSchemaRule,
} from '../src/index.js';

// Builds a single-tool set; reads the JSON Schema after patching.
function toolWith(schema: any) {
  return { demo: tool({ description: 'd', inputSchema: schema, execute: async () => 'ok' }) };
}
function schemaOf(tools: any): any {
  return (tools.demo.inputSchema as any).jsonSchema;
}

describe('detectModel', () => {
  it("string 'provider/model'", () => {
    expect(detectModel('openai/gpt-4o')).toEqual({ provider: 'openai', modelId: 'gpt-4o' });
  });
  it('LanguageModelV2-like object (provider with a dot)', () => {
    expect(detectModel({ provider: 'openai.chat', modelId: 'gpt-4o' })).toEqual({
      provider: 'openai',
      modelId: 'gpt-4o',
    });
  });
  it('google.generative-ai', () => {
    expect(detectModel({ provider: 'google.generative-ai', modelId: 'gemini-1.5-pro' })).toEqual({
      provider: 'google',
      modelId: 'gemini-1.5-pro',
    });
  });
  it('unknown → empty fields', () => {
    expect(detectModel(null)).toEqual({ provider: '', modelId: '' });
  });
});

describe('openaiStrict', () => {
  it('.url() format is moved into the description, additionalProperties:false + all fields required', () => {
    const tools = toolWith(z.object({ u: z.string().url(), n: z.number().optional() }));
    const out = applyToolCompat(tools, 'openai/gpt-4o', defaultRules);
    const s = schemaOf(out);
    expect(s.properties.u.format).toBeUndefined();
    expect(s.properties.u.description ?? '').toContain('format');
    expect(s.additionalProperties).toBe(false);
    expect(s.required).toEqual(expect.arrayContaining(['u', 'n']));
  });

  it('groq provider is also caught', () => {
    const tools = toolWith(z.object({ x: z.string() }));
    const out = applyToolCompat(tools, { provider: 'groq.chat', modelId: 'llama-3.1' }, defaultRules);
    expect(schemaOf(out).additionalProperties).toBe(false);
  });
});

describe('gemini', () => {
  it('$schema and additionalProperties are stripped, format is moved into the description', () => {
    const tools = toolWith(z.object({ x: z.string().email() }));
    const out = applyToolCompat(tools, 'google/gemini-1.5-pro', defaultRules);
    const s = schemaOf(out);
    expect(s.$schema).toBeUndefined();
    expect(s.additionalProperties).toBeUndefined();
    expect(s.properties.x.format).toBeUndefined();
  });
});

describe('anthropic', () => {
  it('format is moved into the description (minimal touch)', () => {
    const tools = toolWith(z.object({ x: z.string().uuid() }));
    const out = applyToolCompat(tools, { provider: 'anthropic.messages', modelId: 'claude-3-5-sonnet' }, defaultRules);
    expect(schemaOf(out).properties.x.format).toBeUndefined();
  });
});

describe('applyToolCompat — general behavior', () => {
  it('for a non-matching model the tool set returns the SAME reference (no-op)', () => {
    const tools = toolWith(z.object({ x: z.string() }));
    const same = applyToolCompat(tools, 'mistral/mistral-large', defaultRules);
    expect(same).toBe(tools);
  });

  it('execute and description are preserved', () => {
    const tools = toolWith(z.object({ x: z.string() }));
    const out = applyToolCompat(tools, 'openai/gpt-4o', defaultRules);
    expect(typeof out.demo.execute).toBe('function');
    expect(out.demo.description).toBe('d');
  });

  it('also handles an MCP-style jsonSchema input', () => {
    const tools = {
      demo: tool({
        description: 'd',
        inputSchema: jsonSchema({
          type: 'object',
          properties: { u: { type: 'string', format: 'email' } },
          required: ['u'],
        }),
        execute: async () => 'ok',
      }),
    };
    const out = applyToolCompat(tools, 'openai/gpt-4o', defaultRules);
    const s = schemaOf(out);
    expect(s.properties.u.format).toBeUndefined();
    expect(s.additionalProperties).toBe(false);
  });

  it('custom rule is added to the pipeline (composition)', () => {
    const addTitle: ToolSchemaRule = {
      name: 'add-title',
      shouldApply: () => true,
      transform: (s) => {
        s.title = 'X';
        return s;
      },
    };
    const tools = toolWith(z.object({ x: z.string() }));
    const out = applyToolCompat(tools, 'openai/gpt-4o', [...defaultRules, addTitle]);
    expect(schemaOf(out).title).toBe('X');
  });

  it('a throwing rule does not drop the tool (the others still apply)', () => {
    const boom: ToolSchemaRule = {
      name: 'boom',
      shouldApply: () => true,
      transform: () => {
        throw new Error('boom');
      },
    };
    const tools = toolWith(z.object({ x: z.string().url() }));
    const out = applyToolCompat(tools, 'openai/gpt-4o', [boom, ...defaultRules]);
    // boom is skipped, openaiStrict still runs
    expect(schemaOf(out).additionalProperties).toBe(false);
  });
});

// The two declarations of a rule must stay compatible.
//
// @gnldev/durable declares `ToolSchemaRuleLike` structurally instead of importing `ToolSchemaRule`
// from here. It has to: this package is an OPTIONAL peer, and a published `.d.ts` is compiled by the
// CONSUMER — so referencing it unconditionally broke `tsc` for anyone who had not opted in. Measured
// on a project with every required peer installed and only this one absent, `skipLibCheck: false`:
//
//   run.d.ts(9,37):      error TS2307: Cannot find module '@gnldev/tool-schema'
//   registry.d.ts(3,37): error TS2307: Cannot find module '@gnldev/tool-schema'
//
// The cost of declaring it twice is drift. NOTE WHAT DOES AND DOES NOT CATCH IT: no package in this
// repo typechecks its tests — every tsconfig is `include: ["src"]` — so a type annotation in a test
// file is documentation, not a guard. Writing `const x: SomeType = y` here proves nothing; it was
// measured, by adding a required field to one declaration and watching both `vitest` and
// `pnpm typecheck` stay green.
//
// What follows is therefore a RUNTIME check: a rule object built to durable's declaration is handed to
// this package's own entry point and must be accepted and applied. That is the property that matters —
// if the declarations diverge in a way that breaks callers, this call stops working.
describe('a rule written against durable\'s declaration', () => {
  it('is accepted and applied by applyToolCompat', () => {
    const seen: string[] = [];
    const mine = {
      name: 'mine',
      shouldApply: (m: { provider: string; modelId: string }) => { seen.push(m.provider); return m.provider === 'x'; },
      transform: (schema: Record<string, any>) => { schema.marker = true; return schema; },
    };

    const out = applyToolCompat(
      { t: { inputSchema: { type: 'object', properties: {} } } },
      { provider: 'x', modelId: 'y' },
      [mine],
    );

    expect(seen, 'the rule was never consulted').toEqual(['x']);
    const schema = (out.t as { inputSchema: any }).inputSchema;
    expect((schema.jsonSchema ?? schema).marker, 'the transform did not run').toBe(true);
  });

  it('is skipped when it says it does not apply', () => {
    const mine = {
      name: 'mine',
      shouldApply: () => false,
      transform: (schema: Record<string, any>) => { schema.marker = true; return schema; },
    };
    const out = applyToolCompat({ t: { inputSchema: { type: 'object', properties: {} } } }, { provider: 'z', modelId: 'y' }, [mine]);
    const schema = (out.t as { inputSchema: any }).inputSchema;
    expect((schema.jsonSchema ?? schema).marker).toBeUndefined();
  });

  it('this package\'s own rules satisfy the same shape at runtime', () => {
    // The other direction: every shipped rule must still look like what durable expects to receive.
    for (const r of defaultRules) {
      expect(typeof r.name, `${r.name}: name`).toBe('string');
      expect(typeof r.shouldApply, `${r.name}: shouldApply`).toBe('function');
      expect(typeof r.transform, `${r.name}: transform`).toBe('function');
    }
  });
});
