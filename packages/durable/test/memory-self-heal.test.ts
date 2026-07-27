// review finding A — memory-append marker self-heal: under the old boolean-claim (marker set FIRST,
// boolean `true`), if memory.append threw a TRANSIENT error, the marker stayed permanently "claimed"
// → a legitimate retry with the same runId ALWAYS lost the claim, and append was skipped FOREVER (a
// permanent loss of conversation history). Fix: a two-phase marker (`{status:'pending', startedAt}` →
// on success `true`) — a stale pending is taken over on the NEXT retry (self-heal), and append is retried.
//
// WRITE-AHEAD note: since writeAheadIncoming (run.ts) the FIRST memory.append of a run happens
// PRE-MODEL (the incoming user message, under runKeys.memUserAppended) and the completion append
// persists only the PRODUCED messages (under runKeys.memAppended). The flaky memory below throws on
// its first call — which is now the write-ahead — so these tests exercise the SAME two-phase
// self-heal contract on the new marker, plus the completion half after the heal.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import type { Memory } from '../src/memory.js';
import { createMockModel, createMockStreamModel } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function echoModel() {
  return createMockModel(async () => ({
    content: [{ type: 'text', text: 'reply' }],
    finishReason: 'stop',
    usage,
    warnings: [],
  }));
}

/** A fake memory that throws on the first call, then works normally afterward. */
function makeFlakyMemory(journal: InMemoryJournal): { memory: Memory; calls: () => number } {
  let calls = 0;
  const memory: Memory = {
    async getMessages(threadId: string) {
      return (await journal.get<any[]>(`mem:${threadId}:messages`)) ?? [];
    },
    async append(threadId: string, messages: any[]) {
      calls++;
      if (calls === 1) throw new Error('transient error (e.g. DB connection dropped)');
      const current = (await journal.get<any[]>(`mem:${threadId}:messages`)) ?? [];
      await journal.put(`mem:${threadId}:messages`, [...current, ...messages]);
    },
  };
  return { memory, calls: () => calls };
}

describe('memory-append self-heal (review finding A)', () => {
  it('runDurable: append throws on the FIRST call (the write-ahead) → runDurable rejects; the marker stays "pending" (NO permanent lock)', async () => {
    const journal = new InMemoryJournal();
    const { memory, calls } = makeFlakyMemory(journal);

    await expect(
      runDurable({ runId: 'heal1', journal, memory, threadId: 'th1', model: echoModel(), prompt: 'hello' }),
    ).rejects.toThrow('transient error');
    expect(calls()).toBe(1);

    // The first append is now the PRE-MODEL write-ahead → its own marker holds the pending claim.
    const rec = await journal.get<any>(runKeys.memUserAppended('heal1'));
    // Under the old boolean-claim, this would be `true` (permanently "claimed") here → a retry would
    // NEVER append. New behavior: 'pending' — not DONE yet, just claimed.
    expect(rec).toEqual({ status: 'pending', startedAt: expect.any(Number) });
    // The run died before the model → the completion marker was never even claimed.
    expect(await journal.get(runKeys.memAppended('heal1'))).toBeUndefined();
  });

  it('runDurable: after the pending goes STALE, a retry with the SAME runId → history is written EXACTLY ONCE', async () => {
    const journal = new InMemoryJournal();
    const { memory, calls } = makeFlakyMemory(journal);

    await expect(
      runDurable({ runId: 'heal2', journal, memory, threadId: 'th2', model: echoModel(), prompt: 'hello' }),
    ).rejects.toThrow('transient error');
    expect(calls()).toBe(1);

    // Instead of waiting for the real TTL, make the pending stale directly (deterministic + fast in
    // tests) — only public journal.get/put + runKeys are used, the internal function is untouched.
    const marker = runKeys.memUserAppended('heal2'); // the write-ahead's marker (the append that threw)
    const pending = await journal.get<any>(marker);
    await journal.put(marker, { ...pending, startedAt: Date.now() - 61_000 }); // stale beyond the 60s TTL

    const r2 = await runDurable({ runId: 'heal2', journal, memory, threadId: 'th2', model: echoModel(), prompt: 'hello' });
    expect(r2.text).toBe('reply');
    // 1st attempt (write-ahead threw) + 2nd attempt's write-ahead (took over via self-heal, succeeded)
    // + 2nd attempt's completion append (produced) — the two halves are separate appends now.
    expect(calls()).toBe(3);

    const saved = await memory.getMessages('th2');
    expect(saved.length).toBe(2); // user + assistant — written EXACTLY ONCE (not doubled, not missing)
    expect(await journal.get(marker)).toBe(true); // the write-ahead marker is now 'done'
    expect(await journal.get(runKeys.memAppended('heal2'))).toBe(true); // and so is the completion marker
  });

  it('runDurable: retry while pending is FRESH (self-heal NOT TRIGGERED) → append is still skipped (in-flight assumption)', async () => {
    const journal = new InMemoryJournal();
    const { memory, calls } = makeFlakyMemory(journal);

    await expect(
      runDurable({ runId: 'heal3', journal, memory, threadId: 'th3', model: echoModel(), prompt: 'hello' }),
    ).rejects.toThrow('transient error');
    expect(calls()).toBe(1);

    // Pending is FRESH (not made stale) → the next retry assumes another worker has it in-flight and
    // SKIPS the append (avoiding a false positive takes precedence over the double-append risk — the safe side).
    const r2 = await runDurable({ runId: 'heal3', journal, memory, threadId: 'th3', model: echoModel(), prompt: 'hello' });
    expect(r2.text).toBe('reply');
    // The write-ahead (user half) was NOT retried — fresh pending → left to the presumed in-flight
    // owner. The COMPLETION half (produced) has its own marker and still lands: calls = the throwing
    // write-ahead (1) + the completion append (2).
    expect(calls()).toBe(2);
    const saved = await memory.getMessages('th3');
    expect(saved.filter((m: any) => m?.role === 'user')).toEqual([]); // user half deferred (FRESH-pending guard)
    expect(saved.length).toBe(1); // the produced half (assistant reply) is not lost
  });

  it('runDurable: two concurrent finishes → only the winner appends (marker atomicity is preserved)', async () => {
    const journal = new InMemoryJournal();
    const memory: Memory = {
      async getMessages(threadId: string) {
        return (await journal.get<any[]>(`mem:${threadId}:messages`)) ?? [];
      },
      async append(threadId: string, messages: any[]) {
        const current = (await journal.get<any[]>(`mem:${threadId}:messages`)) ?? [];
        await journal.put(`mem:${threadId}:messages`, [...current, ...messages]);
      },
    };

    // Journal the model step AHEAD of time (a pre-run without memory) → racers read the model step
    // FROM REPLAY (the model-claim race never kicks in); the test measures ONLY the memory-append
    // marker's atomicity (an isolated slice of the real concurrent-worker scenario).
    await runDurable({ runId: 'race1', journal, model: echoModel(), prompt: 'x' });

    const [r1, r2] = await Promise.all([
      runDurable({ runId: 'race1', journal, memory, threadId: 'thr', model: echoModel(), prompt: 'x' }),
      runDurable({ runId: 'race1', journal, memory, threadId: 'thr', model: echoModel(), prompt: 'x' }),
    ]);
    expect(r1.text).toBe('reply');
    expect(r2.text).toBe('reply');

    const saved = await memory.getMessages('thr');
    expect(saved.length).toBe(2); // only the WINNING worker appended — user + assistant (NOT doubled)
    expect(await journal.get(runKeys.memAppended('race1'))).toBe(true);
  });

  it('streamDurable: the same self-heal pattern also holds in onFinish (parity)', async () => {
    const journal = new InMemoryJournal();
    const { memory, calls } = makeFlakyMemory(journal);
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'reply' },
      { type: 'text-end', id: '1' },
      { type: 'finish', finishReason: 'stop', usage },
    ];

    // The write-ahead append runs PRE-STREAM and its failure REJECTS streamDurable() itself — a clean
    // synchronous error (no tokens were spent), instead of the old mid-onFinish console.warn.
    await expect(
      streamDurable({
        runId: 'sheal1', journal, memory, threadId: 'sh1', model: createMockStreamModel(parts), prompt: 'hello',
      }),
    ).rejects.toThrow('transient error');
    expect(calls()).toBe(1);
    const marker = runKeys.memUserAppended('sheal1');
    const rec = await journal.get<any>(marker);
    expect(rec).toEqual({ status: 'pending', startedAt: expect.any(Number) });

    // Make it stale + retry (simulating a new process) → self-heal takes over, append succeeds.
    await journal.put(marker, { ...rec, startedAt: Date.now() - 61_000 });
    const r2 = await streamDurable({
      runId: 'sheal1', journal, memory, threadId: 'sh1', model: createMockStreamModel(parts), prompt: 'hello',
    });
    await r2.text;
    // write-ahead (user, call 2) + onFinish completion (produced, call 3 — async, wait for it).
    const t1 = Date.now();
    while ((await memory.getMessages('sh1')).length < 2 && Date.now() - t1 < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls()).toBe(3);
    const saved = await memory.getMessages('sh1');
    expect(saved.length).toBe(2);
    expect(await journal.get(marker)).toBe(true);
    expect(await journal.get(runKeys.memAppended('sheal1'))).toBe(true);
  });
});
