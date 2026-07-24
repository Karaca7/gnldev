// AUDIT B3(b) — streaming block/limit VISIBILITY (the other half of B3): runDurable THROWS on a
// loop/maxToolCalls/duplicate/tainted block, but streamDurable only left a `__gnl_blocked`/
// `__gnl_limit_exceeded` sentinel in `fullStream` — a direct consumer who forgot
// `streamFinishError(steps)` never learned the protection fired (the tool WAS blocked either way;
// this was a visibility gap, not a bypass). Two additive mechanisms close it:
//   (1) `onBlocked` callback (StreamDurableArgs + registry RunOptions → gnl.stream) — invoked once at
//       stream finish with the RAW structured breach `{ kind, message, detail }` (no invented
//       user-facing message; the app decides what to show).
//   (2) terminal-promise reject — `await result.text` (and the other terminal promises) REJECTS with
//       the SAME typed error `streamFinishError(steps)` returns, mirroring runDurable's throw.
//       `steps`/`finishReason`/`usage`/`fullStream` deliberately keep the sentinel contract —
//       @gnl/server sse.ts, @gnl/agui and @gnl/studio post-scan `steps` and must NOT get a reject.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { streamDurable } from '../src/run.js';
import { createGnl } from '../src/registry.js';
import { RunLimitExceededError } from '../src/limits.js';

const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
const parts = (arr: any[]) =>
  new ReadableStream({
    start(c) {
      for (const p of arr) c.enqueue(p);
      c.close();
    },
  });

/** Stream mock (modeled on stream-fidelity's fidelityModel): keeps calling the `ping` tool
 *  (call-1, call-2, … with DISTINCT args — no loop-detection interplay) until `calls` tool results
 *  exist in the prompt, then streams the final text. */
function repeatToolStreamModel(calls: number): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-repeat-tool',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('stream only');
    },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done < calls) {
        return {
          stream: parts([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${done + 1}`, toolName: 'ping', input: JSON.stringify({ n: done + 1 }) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]),
        };
      }
      return {
        stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' },
          { type: 'text-delta', id: 't', delta: 'All done.' },
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
      };
    },
  };
}

function makePing(counter: { runs: number }) {
  return tool({
    description: 'ping',
    inputSchema: z.object({ n: z.number() }),
    execute: async () => ({ ok: ++counter.runs }),
  });
}

async function waitFor(cond: () => boolean, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) return;
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('AUDIT B3(b) — streaming block/limit visibility (onBlocked + terminal-promise reject)', () => {
  it('(a) onBlocked fires exactly ONCE with the RAW structured maxToolCalls breach — and the tool call itself WAS blocked', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const breaches: any[] = [];
    const res = await streamDurable({
      runId: 'vis-a', journal, model: repeatToolStreamModel(2), tools: { ping: makePing(counter) },
      prompt: 'go', stopWhen: stepCountIs(6),
      limits: { maxToolCalls: 1 },
      onBlocked: (b) => { breaches.push(b); },
    });
    for await (const _ of res.fullStream) { /* drain — a direct consumer just reading the stream */ }
    await waitFor(() => breaches.length > 0); // onFinish is async relative to stream end
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ kind: 'maxToolCalls' });
    expect(typeof breaches[0].message).toBe('string');
    // RAW structured breach — the sentinel's own detail, no invented user-facing message.
    expect(breaches[0].detail).toMatchObject({ kind: 'maxToolCalls', limit: 1 });
    expect(counter.runs).toBe(1); // 2nd call blocked BEFORE execute — protection is real, not just reported
  });

  it('(b) await result.text REJECTS with the typed limit error (mirrors runDurable throwing)', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const res = await streamDurable({
      runId: 'vis-b', journal, model: repeatToolStreamModel(2), tools: { ping: makePing(counter) },
      prompt: 'go', stopWhen: stepCountIs(6),
      limits: { maxToolCalls: 1 },
    });
    // NO fullStream consumption, NO steps post-scan — the "forgot streamFinishError" consumer.
    await expect(res.text).rejects.toBeInstanceOf(RunLimitExceededError);
    await expect(res.text).rejects.toMatchObject({ detail: { kind: 'maxToolCalls', limit: 1 } });
    expect(counter.runs).toBe(1);
  });

  it('(b2) the steps/finishReason/usage promises do NOT reject — the sse.ts/agui post-scan contract is preserved', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const res = await streamDurable({
      runId: 'vis-b2', journal, model: repeatToolStreamModel(2), tools: { ping: makePing(counter) },
      prompt: 'go', stopWhen: stepCountIs(6),
      limits: { maxToolCalls: 1 },
    });
    for await (const _ of res.fullStream) { /* sse.ts-style consumption */ }
    const steps = await res.steps; // MUST resolve (sse.ts line `await result.steps` has no catch)
    const { streamFinishError } = await import('../src/run.js');
    expect(streamFinishError(steps as any[])).toBeInstanceOf(RunLimitExceededError); // post-scan still works
    await expect(Promise.resolve(res.finishReason)).resolves.toBeDefined();
    await expect(Promise.resolve(res.usage)).resolves.toBeDefined();
  });

  it('(c) run with NO breach → onBlocked NOT called, result.text resolves normally', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const breaches: any[] = [];
    const res = await streamDurable({
      runId: 'vis-c', journal, model: repeatToolStreamModel(1), tools: { ping: makePing(counter) },
      prompt: 'go', stopWhen: stepCountIs(6),
      limits: { maxToolCalls: 5 },
      onBlocked: (b) => { breaches.push(b); },
    });
    await expect(res.text).resolves.toContain('All done.');
    await waitFor(() => breaches.length > 0, 100);
    expect(breaches).toHaveLength(0);
    expect(counter.runs).toBe(1);
  });

  it('(d) registry forward: gnl.stream(name, { onBlocked }) surfaces the breach (RunOptions → streamDurable)', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const breaches: any[] = [];
    const gnl = createGnl({
      journal,
      agents: { pinger: { model: repeatToolStreamModel(2), tools: { ping: makePing(counter) }, maxSteps: 6 } },
    });
    const res = await gnl.stream('pinger', {
      runId: 'vis-d', prompt: 'go',
      limits: { maxToolCalls: 1 },
      onBlocked: (b: any) => { breaches.push(b); },
    });
    await expect((res as any).text).rejects.toBeInstanceOf(RunLimitExceededError);
    await waitFor(() => breaches.length > 0);
    expect(breaches).toHaveLength(1);
    expect(breaches[0]).toMatchObject({ kind: 'maxToolCalls' });
  });

  it('(e) a throwing onBlocked is swallowed (advisory callback) — the stream and its promises are unaffected', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const res = await streamDurable({
      runId: 'vis-e', journal, model: repeatToolStreamModel(2), tools: { ping: makePing(counter) },
      prompt: 'go', stopWhen: stepCountIs(6),
      limits: { maxToolCalls: 1 },
      onBlocked: () => { throw new Error('app callback bug'); },
    });
    // The callback throwing must not mask the typed error nor break the finish path.
    await expect(res.text).rejects.toBeInstanceOf(RunLimitExceededError);
  });
});
