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
