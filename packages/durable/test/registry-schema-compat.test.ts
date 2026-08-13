// @gnldev/tool-schema's README documents exactly one way to switch the package on:
//
//   createGnl({ ...config, schemaCompat: defaultRules })
//
// The registry forwarded a fixed allowlist of options to runDurable, and schemaCompat was not on it,
// so that call parsed, type-checked, and did nothing at all — the package's only documented
// integration was a silent no-op. Silent is the problem: a tool schema the provider rejects fails at
// the provider, far from the line that was supposed to fix it.
//
// Found by an audit that ran every documented sample instead of reading it.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { createGnl, InMemoryStorage } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

/** Records the tool JSON Schema the model was actually handed. */
function capturingModel(seen: { schema?: any }) {
  return {
    specificationVersion: 'v2',
    provider: 'openai.chat', // so the openai-strict rule is the one under test
    modelId: 'gpt-4o',
    supportedUrls: {},
    doGenerate: async ({ tools }: any) => {
      const t = tools?.[0]?.inputSchema;
      seen.schema = t?.jsonSchema ?? t;
      return { content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] };
    },
    doStream: async () => {
      throw new Error('generate-only');
    },
  } as any;
}

// A `.url()` becomes format:'uri', which is what the OpenAI strict rule strips — the exact case the
// package README's example is about.
const visit = () =>
  tool({ description: 'takes a url', inputSchema: z.object({ site: z.string().url() }), execute: async () => ({ ok: true }) });

describe('createGnl forwards schemaCompat, the way tool-schema documents it', () => {
  it('applies the rules when asked', async () => {
    const seen: { schema?: any } = {};
    const gnl = createGnl({
      storage: new InMemoryStorage(),
      schemaCompat: true,
      agents: { a: { model: capturingModel(seen), tools: { visit: visit() } as any } },
    } as any);

    await gnl.run('a', { runId: 'sc-on', prompt: 'hi' });

    // openai-strict moves an unsupported string `format` into the description and closes the object.
    expect(seen.schema?.properties?.site?.format).toBeUndefined();
    expect(seen.schema?.additionalProperties).toBe(false);
  });

  it('leaves the schema alone when not asked', async () => {
    const seen: { schema?: any } = {};
    const gnl = createGnl({
      storage: new InMemoryStorage(),
      agents: { a: { model: capturingModel(seen), tools: { visit: visit() } as any } },
    } as any);

    await gnl.run('a', { runId: 'sc-off', prompt: 'hi' });

    expect(seen.schema?.properties?.site?.format).toBe('uri');
  });
});
