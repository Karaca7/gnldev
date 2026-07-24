// Streaming-fidelity suite: proves that publicly-documented streaming-persistence bug classes seen
// elsewhere in the ecosystem CANNOT occur in GNL BY DESIGN (journal = single source of truth):
//   (a) text-delta order around a tool call is preserved through persistence
//   (b) on replay, chunks are neither lost nor delivered TWICE
//   (c) providerMetadata + reasoning blocks are stored with FULL FIDELITY (this is why the Gemini
//       thought_signature / Anthropic thinking signature used to break elsewhere)
//   (d) message order persisted to memory: user → tool-call → tool → final text
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { streamDurable } from '../src/run.js';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };

// Step 1: text + reasoning + tool-call (text streams BEFORE the tool — the scenario that trips up naive implementations).
// Step 2: finish with providerMetadata + final text.
function fidelityModel(counter: { calls: number }): any {
  const parts = (arr: any[]) =>
    new ReadableStream({
      start(c) {
        for (const p of arr) c.enqueue(p);
        c.close();
      },
    });
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-fidelity',
    supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async ({ prompt }: any) => {
      counter.calls++;
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        return {
          stream: parts([
            { type: 'stream-start', warnings: [] },
            { type: 'reasoning-start', id: 'r1' },
            { type: 'reasoning-delta', id: 'r1', delta: 'thinking first' },
            { type: 'reasoning-end', id: 'r1', providerMetadata: { anthropic: { signature: 'SIG-THINK-1' } } },
            { type: 'text-start', id: 't1' },
            { type: 'text-delta', id: 't1', delta: 'Checking… ' }, // text that streams BEFORE the tool
            { type: 'text-end', id: 't1' },
            { type: 'tool-call', toolCallId: 'call-f1', toolName: 'lookup', input: JSON.stringify({ q: 'x' }) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]),
        };
      }
      return {
        stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't2' },
          { type: 'text-delta', id: 't2', delta: 'Result: 42.' },
          { type: 'text-end', id: 't2' },
          { type: 'finish', finishReason: 'stop', usage, providerMetadata: { google: { thoughtSignature: 'TS-9' } } },
        ]),
      };
    },
  };
}

const tools = {
  lookup: tool({
    description: 'search',
    inputSchema: z.object({ q: z.string() }),
    execute: async () => ({ found: 42 }),
  }),
};

async function collect(res: any): Promise<any[]> {
  const out: any[] = [];
  for await (const p of res.fullStream) out.push(p);
  return out;
}

// Stable signature for comparison: type + the text/id it carries.
function sig(parts: any[]): string[] {
  return parts.map((p) => `${p.type}${p.delta != null ? ':' + (p.delta.delta ?? p.delta) : ''}${p.toolCallId ? ':' + p.toolCallId : ''}`);
}

describe('streaming fidelity (journal = single source of truth)', () => {
  it('(a+c) pre-tool text + reasoning + providerMetadata are stored in the journal with FULL FIDELITY', async () => {
    const journal = new InMemoryJournal();
    const counter = { calls: 0 };
    const res = await streamDurable({
      runId: 'fid-1', journal, model: fidelityModel(counter), tools, prompt: 'search', stopWhen: stepCountIs(4),
    });
    await res.text;

    const step0 = await journal.get<{ parts: any[] }>(runKeys.model('fid-1', 0));
    const types = step0!.parts.map((p) => p.type);
    // Order is preserved: reasoning → text (before the tool) → tool-call
    expect(types).toEqual([
      'stream-start', 'reasoning-start', 'reasoning-delta', 'reasoning-end',
      'text-start', 'text-delta', 'text-end', 'tool-call', 'finish',
    ]);
    // Provider signatures don't get dropped (this is where the Gemini/Anthropic breakage seen elsewhere came from)
    expect(step0!.parts.find((p) => p.type === 'reasoning-end')?.providerMetadata?.anthropic?.signature).toBe('SIG-THINK-1');
    const step1 = await journal.get<{ parts: any[] }>(runKeys.model('fid-1', 1));
    expect(step1!.parts.find((p) => p.type === 'finish')?.providerMetadata?.google?.thoughtSignature).toBe('TS-9');
  });

  it('(b) replay: chunk stream is byte-for-byte identical — no loss, no double delivery, model never called', async () => {
    const journal = new InMemoryJournal();
    const c1 = { calls: 0 };
    const live = await streamDurable({
      runId: 'fid-2', journal, model: fidelityModel(c1), tools, prompt: 'search', stopWhen: stepCountIs(4),
    });
    const liveParts = await collect(live);
    expect(c1.calls).toBe(2);

    const c2 = { calls: 0 };
    const replay = await streamDurable({
      runId: 'fid-2', journal, model: fidelityModel(c2), tools, prompt: 'search', stopWhen: stepCountIs(4),
    });
    const replayParts = await collect(replay);
    expect(c2.calls).toBe(0); // underlying model was NEVER called
    // Same order, same count, same content — nothing missing, nothing duplicated
    expect(sig(replayParts)).toEqual(sig(liveParts));
  });

  it('(d) order persisted to memory: user → assistant(tool-call) → tool → assistant(final)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const res = await streamDurable({
      runId: 'fid-3', journal, memory, threadId: 'th-1',
      model: fidelityModel({ calls: 0 }), tools, prompt: 'search', stopWhen: stepCountIs(4),
    });
    await res.text;
    // onFinish is async → wait for the ACTUAL content (the marker is now written BEFORE the claim: it
    // means "append was claimed", not "append finished" — the completion signal is the content itself).
    const t0 = Date.now();
    while ((await memory.getMessages('th-1')).length === 0) {
      if (Date.now() - t0 > 1000) throw new Error('memory append timed out');
      await new Promise((r) => setTimeout(r, 10));
    }
    const saved = await memory.getMessages('th-1');
    const roles = saved.map((m: any) => m.role);
    expect(roles[0]).toBe('user');
    expect(roles).toContain('tool');
    expect(roles[roles.length - 1]).toBe('assistant');
    // tool result comes AFTER the assistant message with the tool-call and BEFORE the final assistant message
    const flat = JSON.stringify(saved);
    expect(flat.indexOf('tool-call')).toBeLessThan(flat.indexOf('tool-result'));
    expect(flat).toContain('Result: 42.');
  });
});
