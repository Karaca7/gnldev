// 8.8 schemaCompat integration: opt-in tool-schema transformation in runDurable, preserving correctness.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { tool } from 'ai';
import { runDurable } from '../src/run.js';
import { InMemoryJournal } from '../src/journal.js';
import { countToolResults } from './mock.js';

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

// provider 'openai.chat' → detectModel → 'openai' → the openaiStrict rule is applied.
// doGenerate pushes the tool definitions going to the model into `capture` (to verify the schema).
function makeModel(capture: any[]): any {
  return {
    specificationVersion: 'v2',
    provider: 'openai.chat',
    modelId: 'gpt-4o',
    supportedUrls: {},
    doGenerate: async (options: any) => {
      capture.push(options.tools);
      const done = countToolResults(options.prompt);
      if (done === 0) {
        return {
          content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'lookup', input: JSON.stringify({ u: 'http://x.com' }) }],
          finishReason: 'tool-calls' as const,
          usage,
          warnings: [] as any[],
        };
      }
      return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
    },
    doStream: async () => {
      throw new Error('mock: no stream');
    },
  };
}

function makeTools() {
  const counter = { n: 0 };
  const tools = {
    lookup: tool({
      description: 'lookup',
      inputSchema: z.object({ u: z.string().url() }),
      execute: async () => {
        counter.n++;
        return 'ok';
      },
    }),
  };
  return { tools, counter };
}

// JSON schema of the lookup tool sent to the model.
function schemaSeen(capture: any[]): any {
  const arr = capture[0] ?? [];
  return arr.find((t: any) => t.name === 'lookup')?.inputSchema;
}

describe('schemaCompat integration (run.ts)', () => {
  it('opt-out: when schemaCompat is not given, schema is RAW (url format remains)', async () => {
    const cap: any[] = [];
    const { tools } = makeTools();
    await runDurable({ runId: 'sc-out', journal: new InMemoryJournal(), model: makeModel(cap), tools, prompt: 'go' } as any);
    expect(schemaSeen(cap).properties.u.format).toBe('uri');
  });

  it('opt-in: schemaCompat:true → format is moved into the description, additionalProperties:false', async () => {
    const cap: any[] = [];
    const { tools } = makeTools();
    await runDurable({
      runId: 'sc-in',
      journal: new InMemoryJournal(),
      model: makeModel(cap),
      tools,
      prompt: 'go',
      schemaCompat: true,
    } as any);
    const js = schemaSeen(cap);
    expect(js.properties.u.format).toBeUndefined();
    expect(js.additionalProperties).toBe(false);
  });

  it('correctness: a patched run does not run the tool AGAIN on replay, no DivergenceError', async () => {
    const cap: any[] = [];
    const { tools, counter } = makeTools();
    const journal = new InMemoryJournal();
    const base = { runId: 'sc-replay', journal, tools, prompt: 'go', schemaCompat: true, replay: 'strict' as const };

    await runDurable({ ...base, model: makeModel(cap) } as any);
    expect(counter.n).toBe(1);

    // resume: same runId + journal → model and tool are replayed from the journal
    await runDurable({ ...base, model: makeModel([]) } as any);
    expect(counter.n).toBe(1); // exactly-once preserved, no args drift → no divergence
  });
});
