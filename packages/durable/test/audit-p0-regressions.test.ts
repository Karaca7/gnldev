// Six defects, found by adversarial audit of the unpushed work, each reproduced by MEASUREMENT before
// being fixed. Each block below reconstructs the auditor's measured scenario, so a regression fails
// the same way the audit did — not a paraphrase of the fix, a replay of the attack.
import { describe, it, expect } from 'vitest';
import { runDurable, streamDurable, InMemoryStorage, listRunsArray, readRunOutcome, runKeys, BasicMemory, RunBusyError, sweepRuns, appendLog } from '../src/index.js';
import { durableTool } from '../src/durable-tool.js';
import { stampFormat } from '../src/format.js';
import type { DurableCtx } from '../src/journal.js';
import { tool } from 'ai';
import { z } from 'zod';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const base = { specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {}, doStream: async () => { throw new Error('gen-only'); } };
const good = { ...base, doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }) } as any;

function sideEffectTool(extra: Record<string, unknown> = {}) {
  let executions = 0;
  const outputs: string[] = [];
  const t = {
    sideEffect: true,
    execute: async () => { executions++; const id = `ch_${executions}`; outputs.push(id); return { chargeId: id }; },
    ...extra,
  };
  return { t, executions: () => executions, outputs };
}

describe('AUDIT-1: a takeover must not clobber a terminal record', () => {
  it('returns the slow worker’s success instead of stamping running over it', async () => {
    // The auditor's interleaving, replayed exactly. The FIRST read of the claim shows a stale
    // 'running' — the staleness verdict says "crashed". But the worker was only SLOW: it finishes and
    // writes 'succeeded' BETWEEN that verdict and the takeover's re-read. The old code handed that
    // fresh success to putIfMatch as `expected`, so the CAS MATCHED it, stamped 'running' over a
    // completed call, re-ran the side effect, and the journal ended holding the duplicate's output
    // with ch_ORIGINAL gone. (Seeding 'succeeded' from the start would NOT test this — the
    // exactly-once gate at the top returns before the takeover branch is ever reached.)
    const inner = new InMemoryStorage().runs;
    const runId = 'takeover-1';
    const key = runKeys.tool(runId, 'call-1');
    await inner.put(key, stampFormat({ status: 'running', startedAt: Date.now() - 120_000, toolName: 'charge' }));

    let reads = 0;
    const journal: any = new Proxy(inner, {
      get(t2, prop, r) {
        if (prop === 'get') {
          return async (k: string) => {
            if (k === key) {
              reads++;
              // After the staleness verdict has been reached on read #1, the slow worker completes.
              if (reads === 2) await inner.put(key, stampFormat({ status: 'succeeded', output: { chargeId: 'ch_ORIGINAL' }, toolName: 'charge' }));
            }
            return inner.get(k);
          };
        }
        const v = Reflect.get(t2, prop, r);
        return typeof v === 'function' ? v.bind(t2) : v;
      },
    });

    const { t, executions } = sideEffectTool({ idempotent: true, sideEffect: false });
    const ctx: DurableCtx = { journal, runId } as DurableCtx;
    const out = await durableTool(t as any, ctx, 'charge').execute!({ amount: 1 }, { toolCallId: 'call-1' });

    expect(out, 'the recorded output is served, not recomputed').toEqual({ chargeId: 'ch_ORIGINAL' });
    expect(executions(), 'the side effect must not run a second time').toBe(0);
    const rec = await inner.get<any>(key);
    expect(rec?.output?.chargeId, 'the original record survives').toBe('ch_ORIGINAL');
  });
});

describe('AUDIT-2: a failed attempt releases the duplicate marker for real', () => {
  const CALL_A = 'dup-a';
  const CALL_B = 'dup-b';

  function failingThenFine() {
    let executions = 0;
    const t = tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async () => {
        executions++;
        if (executions === 1) throw new Error('ETIMEDOUT before anything posted');
        return { chargeId: `ch_${executions}` };
      },
    });
    Object.assign(t, { sideEffect: true });
    return { t: t as any, executions: () => executions };
  }

  it("a legitimate retry under 'block' executes — exactly-once had become exactly-zero", async () => {
    const journal = new InMemoryStorage().runs;
    const { t, executions } = failingThenFine();
    const ctx: DurableCtx = { journal, runId: 'dupfix-1', limits: { sideEffectDuplicates: 'block' } } as DurableCtx;
    const wrapped = durableTool(t, ctx, 'charge');

    await wrapped.execute!({ amount: 5 }, { toolCallId: CALL_A }).catch(() => { /* first attempt fails */ });
    expect(executions()).toBe(1);

    // The model re-plans with a fresh toolCallId and identical arguments. The audit measured the old
    // release (`put(dupKey, undefined)`) leaving the row behind, so this claim lost forever and the
    // retry was blocked as a "concurrent duplicate" of an attempt that never succeeded.
    const out: any = await wrapped.execute!({ amount: 5 }, { toolCallId: CALL_B });
    expect(out?.chargeId, 'the retry must execute').toBe('ch_2');
    expect(executions()).toBe(2);
  });

  it('a duplicate AFTER a success is still blocked — the release must not weaken first-wins', async () => {
    const journal = new InMemoryStorage().runs;
    const { t, executions } = failingThenFine();
    const ctx: DurableCtx = { journal, runId: 'dupfix-2', limits: { sideEffectDuplicates: 'block' } } as DurableCtx;
    const wrapped = durableTool(t, ctx, 'charge');

    await wrapped.execute!({ amount: 5 }, { toolCallId: 'a1' }).catch(() => {});
    await wrapped.execute!({ amount: 5 }, { toolCallId: 'a2' }); // succeeds, finalizes the marker
    const dup: any = await wrapped.execute!({ amount: 5 }, { toolCallId: 'a3' });

    expect(executions(), 'the third call must not run the effect').toBe(2);
    expect(dup?.__gnl_limit_exceeded?.kind).toBe('duplicateSideEffect');
  });
});

describe('AUDIT-3: an errored stream reads failed, not completed', () => {
  it('onFinish does not overwrite the failure the error path recorded', async () => {
    const journal = new InMemoryStorage().runs;
    const runId = 'stream-err-1';
    // A model whose stream emits an error part and finishes with finishReason 'error' — the shape of
    // a 429/503 mid-stream. The audit measured outcome writes ["failed","completed"]: recorded, then
    // un-recorded by the success write in onFinish.
    const model = {
      ...base,
      doGenerate: async () => { throw new Error('stream-only'); },
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'error', error: new Error('429 rate limited mid-stream') });
            c.enqueue({ type: 'finish', finishReason: 'error', usage });
            c.close();
          },
        }),
      }),
    } as any;

    const res = await streamDurable({ runId, journal, model, prompt: 'x' } as any);
    try { for await (const _ of (res as any).fullStream) { /* consume */ } } catch { /* the error */ }
    // Poll for the async onFinish/onError write rather than sleeping a fixed 50ms: what is waited for
    // is the write landing, not a duration. The deadline still fails the test if the write never
    // happens, which is the regression this guards. (Not a reproduced flake — the sibling case in
    // running-status.test.ts was measured and its fixed sleep held even at 1ms under load.)
    const deadline = Date.now() + 5_000;
    let outcome = await readRunOutcome(journal, runId);
    while (outcome?.status !== 'failed' && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 10));
      outcome = await readRunOutcome(journal, runId);
    }
    expect(outcome?.status, 'measured pre-fix: the final record said completed').toBe('failed');
  });
});

describe('AUDIT-4: a stale failure cannot bury a later success', () => {
  it('the newer verdict stands regardless of write order', async () => {
    const journal = new InMemoryStorage().runs;
    const runId = 'race-1';
    // Worker B's resume succeeded and wrote its verdict…
    await runDurable({ runId, journal, model: good, prompt: 'x' } as any);
    const afterSuccess = await readRunOutcome(journal, runId);
    expect(afterSuccess?.status).toBe('completed');

    // …and worker A's much older 'failed' put finally lands (GC pause, contended DB). Plain
    // last-writer-wins let it stamp a succeeded run failed, permanently — measured in the audit.
    const { runFailed } = await import('../src/outcome.js');
    await runFailed(journal, runId, new Error('401 invalid api key'), afterSuccess!.at - 60_000);

    const final = await readRunOutcome(journal, runId);
    expect(final?.status, 'the stale verdict must lose').toBe('completed');
    expect((await listRunsArray(journal)).find((r) => r.runId === runId)?.status).toBe('completed');
  });
});

describe('AUDIT-5: a thread named after a key kind cannot take the memory keyspace down', () => {
  it('rejects the colliding ids at the boundary', async () => {
    const journal = new InMemoryStorage().runs;
    const memory = new BasicMemory(journal as any);
    // Measured: mem:model:messages parsed as run 'mem' → indexed → sweep deleted EVERY thread.
    await expect(memory.append('model', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/collide/);
    await expect(memory.append('tool', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/collide/);
    // The colliding shape is a SEGMENT named after a key kind, wherever it sits.
    await expect(memory.append('a:model:b', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/collide/);
    await expect(memory.append('org:tool', [{ role: 'user', content: 'hi' }])).rejects.toThrow(/collide/);
    // Colons themselves stay legal — sweepThreads' suffix inference has always supported them (a
    // pre-existing test pins it), so the guard must not ban more than the collision.
    await memory.append('org:user-7', [{ role: 'user', content: 'hi' }]);
    expect((await memory.getMessages('org:user-7')).length).toBe(1);
    // And an ordinary thread that merely CONTAINS the word is untouched.
    await memory.append('model-review-chat', [{ role: 'user', content: 'hi' }]);
    expect((await memory.getMessages('model-review-chat')).length).toBe(1);
  });

  it('the sweep leaves ordinary threads alone', async () => {
    const journal = new InMemoryStorage().runs;
    const memory = new BasicMemory(journal as any);
    await memory.append('u1', [{ role: 'user', content: 'precious' }]);
    await runDurable({ runId: 'r1', journal, model: good, prompt: 'x' } as any);

    await sweepRuns(journal as any, { olderThanMs: 0, now: Date.now() + 60_000 });
    expect((await memory.getMessages('u1')).length, 'memory is not run data').toBe(1);
  });
});

describe('AUDIT-6 (adjacent): a mid-flight fence fills the outcome without burying the survivor', () => {
  it('a fenced-out attempt records failed only while no verdict exists', async () => {
    const journal = new InMemoryStorage().runs;
    const { runFailedIfUnrecorded, runSucceeded } = await import('../src/outcome.js');

    // Case 1: no verdict yet → the fence-abort fills it (a run that aborted no longer reads completed).
    await runFailedIfUnrecorded(journal, 'fence-1', new RunBusyError('fenced mid-flight'), Date.now());
    expect((await readRunOutcome(journal, 'fence-1'))?.status).toBe('failed');

    // Case 2: the survivor already succeeded → the fence-abort must not touch it, even though its
    // wall-clock time is later.
    await runSucceeded(journal, 'fence-2', Date.now() - 60_000);
    await runFailedIfUnrecorded(journal, 'fence-2', new RunBusyError('fenced mid-flight'), Date.now());
    expect((await readRunOutcome(journal, 'fence-2'))?.status, "the survivor's verdict stands").toBe('completed');
  });
});
