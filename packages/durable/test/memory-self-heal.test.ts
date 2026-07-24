// review finding A — memory-append marker self-heal: under the old boolean-claim (marker set FIRST,
// boolean `true`), if memory.append threw a TRANSIENT error, the marker stayed permanently "claimed"
// → a legitimate retry with the same runId ALWAYS lost the claim, and append was skipped FOREVER (a
// permanent loss of conversation history). Fix: a two-phase marker (`{status:'pending', startedAt}` →
// on success `true`) — a stale pending is taken over on the NEXT retry (self-heal), and append is retried.
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
  it('runDurable: append throws on the FIRST call → runDurable rejects; the marker stays "pending" (NO permanent lock)', async () => {
    const journal = new InMemoryJournal();
    const { memory, calls } = makeFlakyMemory(journal);

    await expect(
      runDurable({ runId: 'heal1', journal, memory, threadId: 'th1', model: echoModel(), prompt: 'hello' }),
    ).rejects.toThrow('transient error');
    expect(calls()).toBe(1);

    const marker = runKeys.memAppended('heal1');
    const rec = await journal.get<any>(marker);
    // Under the old boolean-claim, this would be `true` (permanently "claimed") here → a retry would
    // NEVER append. New behavior: 'pending' — not DONE yet, just claimed.
    expect(rec).toEqual({ status: 'pending', startedAt: expect.any(Number) });
  });

  it('runDurable: after the pending goes STALE, a retry with the SAME runId → history is written EXACTLY ONCE', async () => {
    const journal = new InMemoryJournal();
    const { memory, calls } = makeFlakyMemory(journal);

    await expect(
      runDurable({ runId: 'heal2', journal, memory, threadId: 'th2', model: echoModel(), prompt: 'hello' }),
    ).rejects.toThrow('transient error');
    expect(calls()).toBe(1);

    // Instead of waiting for the real TTL, make the pending stale directly (deterministic + fast in
    // tests) — only public journal.get/put + runKeys.memAppended are used, the internal function is untouched.
    const marker = runKeys.memAppended('heal2');
    const pending = await journal.get<any>(marker);
    await journal.put(marker, { ...pending, startedAt: Date.now() - 61_000 }); // stale beyond the 60s TTL

    const r2 = await runDurable({ runId: 'heal2', journal, memory, threadId: 'th2', model: echoModel(), prompt: 'hello' });
    expect(r2.text).toBe('reply');
    expect(calls()).toBe(2); // 1st attempt (threw) + 2nd attempt (took over via self-heal, succeeded)

    const saved = await memory.getMessages('th2');
    expect(saved.length).toBe(2); // user + assistant — written EXACTLY ONCE (not doubled, not missing)
    expect(await journal.get(marker)).toBe(true); // the marker is now 'done'
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
    expect(calls()).toBe(1); // append was NOT retried (FRESH pending → skipped)
    expect(await memory.getMessages('th3')).toEqual([]); // history was NOT WRITTEN this turn (the FRESH-pending guard)
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

    const r1 = await streamDurable({
      runId: 'sheal1', journal, memory, threadId: 'sh1', model: createMockStreamModel(parts), prompt: 'hello',
    });
    await r1.text;
    // onFinish is async (there are a few microtasks between the marker WRITE and the append CALL) —
    // wait for the append to have ACTUALLY been attempted (calls>0), not just for the marker to become visible.
    const marker = runKeys.memAppended('sheal1');
    const t0 = Date.now();
    while (calls() === 0 && Date.now() - t0 < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls()).toBe(1);
    // AFTER the append throws, verify the marker VISIBLY stays 'pending' (NO permanent lock).
    await new Promise((r) => setTimeout(r, 10)); // make sure markMemoryAppendDone was NOT called (the append failed)
    const rec = await journal.get<any>(marker);
    expect(rec).toEqual({ status: 'pending', startedAt: expect.any(Number) });

    // Make it stale + resume (simulating a new process) → self-heal takes over, append succeeds.
    await journal.put(marker, { ...rec, startedAt: Date.now() - 61_000 });
    const r2 = await streamDurable({
      runId: 'sheal1', journal, memory, threadId: 'sh1', model: createMockStreamModel(parts), prompt: 'hello',
    });
    await r2.text;
    const t1 = Date.now();
    while ((await memory.getMessages('sh1')).length === 0 && Date.now() - t1 < 1000) {
      await new Promise((r) => setTimeout(r, 10));
    }
    expect(calls()).toBe(2);
    const saved = await memory.getMessages('sh1');
    expect(saved.length).toBe(2);
    expect(await journal.get(marker)).toBe(true);
  });
});
