// Tests for 4.1 (model-step write-ahead claim + replay divergence) and 4.4 (stream
// mid-checkpoint). Purpose: (a) make the claim-crash window visible + retry doesn't shift the step,
// (b) the divergence check is ONLY opt-in (`replay:'strict'`) and ALWAYS soft (never throws) —
// a legitimate resume (request differences seen in memory/processor flows) is NEVER BROKEN,
// (c) periodic partial checkpoints in long streams — the happy-path RESULT is unchanged, but on a
// crash more progress is left in the journal than before.
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { withDurableModel } from '../src/durable-model.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('Model-step write-ahead claim', () => {
  it('claim: running BEFORE the live call, succeeded on success, failed on error → a retry reclaims IMMEDIATELY (the step does not shift)', async () => {
    const journal = new InMemoryJournal();
    let attempt = 0;
    const model = createMockModel(async () => {
      attempt++;
      if (attempt === 1) throw new Error('transient-error');
      return finalTextResult('ok');
    });
    const wrapped = withDurableModel(model, { journal, runId: 'cl1' });

    await expect((wrapped as any).doGenerate({ prompt: [] })).rejects.toThrow('transient-error');
    const afterFail = await journal.get<any>('cl1:proc:__gnl_model_claim:0');
    expect(afterFail?.status).toBe('failed');
    expect(await journal.get('cl1:model:0')).toBeUndefined(); // NO final record — the retry will use the same step

    const result = await (wrapped as any).doGenerate({ prompt: [] });
    expect((result.content[0] as any).text).toBe('ok');
    const afterOk = await journal.get<any>('cl1:proc:__gnl_model_claim:0');
    expect(afterOk?.status).toBe('succeeded');
    expect(await journal.get('cl1:model:0')).toBeDefined();
  });

  it('a real crash scenario: the prefix step\'s claim stays succeeded, the crashed step is reclaimed as failed (exactly 1 charge)', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const tools = { charge: { execute: async () => ({ charged: (charges.n++, 20) }) } };
    const makeModel = (crash: boolean) =>
      createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done === 0) return toolCallResult('charge', 'call-c', { amount: 20 });
        if (crash && done === 1) throw new Error('CRASH');
        return finalTextResult('done');
      });

    await expect(
      runDurable({ runId: 'r-claim', journal, model: makeModel(true), tools, stopWhen: stepCountIs(6), prompt: 'x' }),
    ).rejects.toThrow('CRASH');
    expect(charges.n).toBe(1);
    expect((await journal.get<any>('r-claim:proc:__gnl_model_claim:0'))?.status).toBe('succeeded');
    expect((await journal.get<any>('r-claim:proc:__gnl_model_claim:1'))?.status).toBe('failed');

    const r2 = await runDurable({
      runId: 'r-claim', journal, model: makeModel(false), tools, stopWhen: stepCountIs(6), prompt: 'x',
    });
    expect(charges.n).toBe(1); // NO charge again on resume — exactly-once is preserved
    expect(r2.text).toBe('done');
    expect((await journal.get<any>('r-claim:proc:__gnl_model_claim:1'))?.status).toBe('succeeded');
  });
});

describe('Replay divergence: opt-in + ALWAYS soft', () => {
  function seed(journal: InMemoryJournal, runId: string) {
    return Promise.all([
      journal.put(`${runId}:model:0`, {
        content: [{ type: 'text', text: 'stored-reply' }],
        finishReason: 'stop',
        usage: {},
        warnings: [],
      }),
      journal.put(`${runId}:proc:__gnl_model_claim:0`, { status: 'succeeded', startedAt: Date.now(), reqHash: 'DEADBEEF' }),
    ]);
  }

  it('default (lenient): stays SILENT on request drift — NO noise for a user who has not opted in', async () => {
    const journal = new InMemoryJournal();
    await seed(journal, 'dv1');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = createMockModel(async () => { throw new Error('MUST NOT BE CALLED LIVE'); });
    const wrapped = withDurableModel(model, { journal, runId: 'dv1' }); // replay not given → default lenient
    const result = await (wrapped as any).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'different-request' }] }] });
    expect((result.content[0] as any).text).toBe('stored-reply'); // still REPLAYED from the journal
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("strict opt-in: WARNS on request drift but does NOT BREAK the run (DivergenceError is not thrown)", async () => {
    const journal = new InMemoryJournal();
    await seed(journal, 'dv2');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = createMockModel(async () => { throw new Error('MUST NOT BE CALLED LIVE'); });
    const wrapped = withDurableModel(model, { journal, runId: 'dv2', replay: 'strict' });
    const result = await (wrapped as any).doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'different-request' }] }] });
    expect((result.content[0] as any).text).toBe('stored-reply'); // replay was NOT BROKEN
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it('strict opt-in + the SAME request: no warning is PRODUCED (no false positive)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('dv3:model:0', { content: [{ type: 'text', text: 'stored' }], finishReason: 'stop', usage: {}, warnings: [] });
    const seedPrompt = [{ role: 'user', content: [{ type: 'text', text: 'same-request' }] }];
    // Write the claim with the hash a REAL call would produce (over the same prompt).
    const { argsHash } = await import('../src/hash.js');
    const reqHash = argsHash({ prompt: seedPrompt });
    await journal.put('dv3:proc:__gnl_model_claim:0', { status: 'succeeded', startedAt: Date.now(), reqHash });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const model = createMockModel(async () => { throw new Error('MUST NOT BE CALLED LIVE'); });
    const wrapped = withDurableModel(model, { journal, runId: 'dv3', replay: 'strict' });
    await (wrapped as any).doGenerate({ prompt: seedPrompt });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('Streaming mid-checkpoint', () => {
  function makeChunkedStreamModel(deltaCount: number) {
    const parts: any[] = [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '0' }];
    for (let i = 0; i < deltaCount; i++) parts.push({ type: 'text-delta', id: '0', delta: `p${i}` });
    parts.push({ type: 'text-end', id: '0' }, { type: 'finish', finishReason: 'stop', usage: {} });
    return {
      specificationVersion: 'v2' as const,
      provider: 'mock',
      modelId: 'mock-checkpoint',
      supportedUrls: {},
      doGenerate: async () => { throw new Error('stream only'); },
      doStream: async () => ({
        stream: new ReadableStream({
          start(controller) {
            for (const p of parts) controller.enqueue(p);
            controller.close();
          },
        }),
      }),
    } as any;
  }

  async function collect(stream: any): Promise<any[]> {
    const out: any[] = [];
    const reader = stream.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      out.push(value);
    }
    return out;
  }

  it('happy path: on full consumption the final record stays UNCHANGED (checkpoint is only EXTRA info)', async () => {
    const journal = new InMemoryJournal();
    const model = makeChunkedStreamModel(23); // 27 parts total → checkpoints at 10 and 20
    const wrapped = withDurableModel(model, { journal, runId: 'ck1' });
    const { stream } = await (wrapped as any).doStream({ prompt: [] });
    const got = await collect(stream);
    expect(got.length).toBe(27);

    const final = await journal.get<{ parts: any[] }>('ck1:model:0');
    expect(final?.parts.length).toBe(27); // the final record contains all parts — SAME BEHAVIOR

    const checkpoint = await journal.get<{ parts: any[]; partial: boolean }>('ck1:proc:__gnl_stream_checkpoint:0');
    expect(checkpoint?.partial).toBe(true);
    expect(checkpoint?.parts.length).toBe(20); // the last periodic checkpoint (every 10) — the INTERMEDIATE record was kept

    // Replay: a second instance with the same journal → produces the same stream WITHOUT touching the underlying doStream AT ALL.
    const wrapped2 = withDurableModel(model, { journal, runId: 'ck1' });
    const { stream: replayStream } = await (wrapped2 as any).doStream({ prompt: [] });
    const replayed = await collect(replayStream);
    expect(replayed).toEqual(got);
  });

  it('crash mid-stream: the stream cuts off with an error → the checkpoint preserves PARTIAL progress, the final record is NOT WRITTEN', async () => {
    const journal = new InMemoryJournal();
    const parts: any[] = [{ type: 'stream-start', warnings: [] }];
    for (let i = 0; i < 23; i++) parts.push({ type: 'text-delta', id: '0', delta: `p${i}` });
    // Deliver ONE AT A TIME via pull(): the next part is handed over as the consumer (reader)
    // requests it → this simulates a real "15 parts streamed, then crashed" scenario (instead of
    // enqueue-then-error; otherwise the still-UNREAD queue would DROP the error instantly and the
    // transform would never run at all).
    let i = 0;
    const DELIVER_BEFORE_CRASH = 15;
    const model: any = {
      specificationVersion: 'v2',
      provider: 'mock',
      modelId: 'mock-crash-stream',
      supportedUrls: {},
      doGenerate: async () => { throw new Error('stream only'); },
      doStream: async () => ({
        stream: new ReadableStream({
          pull(controller) {
            if (i < DELIVER_BEFORE_CRASH && i < parts.length) {
              controller.enqueue(parts[i]);
              i++;
            } else {
              controller.error(new Error('STREAM-CRASH')); // finish/close NEVER arrives — simulates a real crash
            }
          },
        }),
      }),
    };
    const wrapped = withDurableModel(model, { journal, runId: 'ck2' });
    const { stream } = await (wrapped as any).doStream({ prompt: [] });
    const reader = stream.getReader();
    await expect(
      (async () => {
        for (;;) {
          const { done } = await reader.read();
          if (done) break;
        }
      })(),
    ).rejects.toThrow();

    // BEFORE (without this change): NOTHING would remain in the journal since flush never ran.
    // NOW: thanks to the periodic checkpoint, at least the last marked progress is preserved.
    const checkpoint = await journal.get<{ parts: any[]; partial: boolean }>('ck2:proc:__gnl_stream_checkpoint:0');
    expect(checkpoint?.partial).toBe(true);
    expect(checkpoint!.parts.length).toBeGreaterThanOrEqual(10);
    expect(checkpoint!.parts.length).toBeLessThan(24); // NOT all parts — partial
    expect(await journal.get('ck2:model:0')).toBeUndefined(); // no final record — flush did not run
    // the claim stays at least 'running' (succeeded was never reached) — the crash is VISIBLE.
    expect((await journal.get<any>('ck2:proc:__gnl_model_claim:0'))?.status).toBe('running');
  });
});
