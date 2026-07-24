// Y1/Y3 — external-call timeout (opt-in) + adjustable claim TTL. Contract:
//   - tool.timeoutMs / timeouts.toolMs: on timeout StepTimeoutError → journal 'failed' (H9 ladder applies),
//   - timeouts.modelStepMs: a hanging doGenerate step is rejected with StepTimeoutError (claim 'failed'),
//   - claimTtlMs: a fresh 'running' claim from a LEGITIMATE tool running longer than 30s is not "assumed crashed".
import { describe, it, expect } from 'vitest';
import {
  InMemoryJournal,
  runKeys,
  runDurable,
  durableTool,
  RunBusyError,
  StepTimeoutError,
} from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('Y1/Y3 — timeout + claim TTL', () => {
  it('tool.timeoutMs: a hanging tool fails with StepTimeoutError, journal record becomes failed', async () => {
    const journal = new InMemoryJournal();
    const dt = durableTool(
      { timeoutMs: 40, idempotent: true, execute: async () => { await sleep(5_000); return 'never'; } },
      { journal, runId: 'to1' },
      'slowTool',
    );
    await expect(dt.execute!({}, { toolCallId: 'call-1' })).rejects.toThrow(StepTimeoutError);
    const rec = await journal.get<any>(runKeys.tool('to1', 'call-1'));
    expect(rec?.status).toBe('failed');
    expect(rec?.error).toContain('timed out');
  });

  it('ctx.toolTimeoutMs (runDurable timeouts.toolMs) becomes the default; tool.timeoutMs overrides per tool', async () => {
    const journal = new InMemoryJournal();
    // ctx default 40ms; the tool declares its own 5000ms → a 100ms job fits COMFORTABLY (proof of the override).
    const dt = durableTool(
      { timeoutMs: 5_000, idempotent: true, execute: async () => { await sleep(100); return 'ok'; } },
      { journal, runId: 'to2', toolTimeoutMs: 40 },
      'slowishTool',
    );
    expect(await dt.execute!({}, { toolCallId: 'call-1' })).toBe('ok');
  });

  it('timeout passes an AbortSignal to execute (cooperative cancellation)', async () => {
    const journal = new InMemoryJournal();
    let sawSignal: unknown;
    const dt = durableTool(
      {
        timeoutMs: 40,
        idempotent: true,
        execute: async (_input: any, opts: any) => { sawSignal = opts?.abortSignal; await sleep(5_000); },
      },
      { journal, runId: 'to3' },
      'slowTool',
    );
    await expect(dt.execute!({}, { toolCallId: 'call-1' })).rejects.toThrow(StepTimeoutError);
    expect(sawSignal).toBeInstanceOf(AbortSignal);
  });

  it('timeouts.modelStepMs: a hanging model step is rejected with StepTimeoutError', async () => {
    const journal = new InMemoryJournal();
    const hangingModel = createMockModel(() => new Promise(() => { /* never resolves */ }));
    await expect(
      runDurable({
        model: hangingModel, journal, runId: 'to4', prompt: 'hi',
        timeouts: { modelStepMs: 40 },
      }),
    ).rejects.toThrow(StepTimeoutError);
  });

  it('claimTtlMs raised: a long-running legitimate tool is not "assumed crashed" (RunBusyError, not reclaimed)', async () => {
    const journal = new InMemoryJournal();
    // A 'running' claim started 45s ago: with the default TTL (30s) it would be considered STALE (idempotent → a
    // second copy would run); with claimTtlMs=120s it is still FRESH → treated as in-flight, RunBusyError.
    await journal.put(runKeys.tool('to5', 'call-1'), { status: 'running', startedAt: Date.now() - 45_000 });
    let calls = 0;
    const dt = durableTool(
      { idempotent: true, claimTtlMs: 120_000, execute: async () => { calls++; return 'ok'; } },
      { journal, runId: 'to5' },
      'longTool',
    );
    await expect(dt.execute!({}, { toolCallId: 'call-1' })).rejects.toThrow(RunBusyError);
    expect(calls).toBe(0); // second copy did NOT start — the gap Y3 closes
  });

  it('with no timeout given, behavior is identical to before (regression)', async () => {
    const journal = new InMemoryJournal();
    const gen = { calls: 0 };
    const model = createMockModel(async ({ prompt }: any) => {
      gen.calls++;
      if (countToolResults(prompt) === 0) return toolCallResult('echo', 'call-1', { x: 1 });
      return finalTextResult('done');
    });
    const res = await runDurable({
      model, journal, runId: 'to6', prompt: 'work',
      tools: { echo: { idempotent: true, execute: async (i: any) => i } as any },
    });
    expect(res.text).toBe('done');
  });
});
