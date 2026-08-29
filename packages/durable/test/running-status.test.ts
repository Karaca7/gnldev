// A run that was killed mid-work used to read 'completed'.
//
// Status had a three-word vocabulary — completed | suspended | failed — and only the ENDINGS were
// recorded. "No terminal record" and "ended fine" were the same absence, so a SIGKILL between the
// throw and the outcome write, or anywhere mid-stream, produced the most misleading answer the
// system could give. The CHANGELOG carried this as a known limit; this makes it a fixed one.
//
// The fix is a write-ahead: every attempt records {status:'running'} at entry, and the terminal
// verdict overwrites it. A run that never said it ended can no longer claim it did.
import { describe, it, expect } from 'vitest';
import {
  runDurable, InMemoryStorage, listRunsArray, readRunOutcome, deriveRunStatus, runStarted,
} from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const base = { specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {}, doStream: async () => { throw new Error('gen-only'); } };
const good = { ...base, doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }) } as any;
const dead = { ...base, doGenerate: async () => { throw new Error('401 invalid api key'); } } as any;

const statusOf = async (journal: any, runId: string) =>
  (await listRunsArray(journal)).find((r) => r.runId === runId)?.status;

/**
 * Polls until the status is the one expected, instead of sleeping a fixed span and hoping.
 *
 * What is being waited for is an EVENT — the write-ahead marker landing — and the `sleep(30)` this
 * replaces encoded it as a duration, which is the shape that turns a contended machine into a red
 * with nothing wrong.
 *
 * Honest about the margin, because it was measured rather than assumed: the old form did NOT flake.
 * Twelve runs under 64 busy processes at load ~40 were green, and so were ten runs with the sleep cut
 * to 1ms — the marker lands effectively at once, so 30ms was never load-bearing. This is the repo's
 * existing pattern (canceled-status.test.ts) applied for robustness, not a fix for a reproduced
 * failure. It costs nothing and removes an assumption; it does not close a known flake.
 */
async function waitForStatus(journal: any, runId: string, want: string, timeoutMs = 5_000): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let seen: string | undefined;
  do {
    seen = await statusOf(journal, runId);
    if (seen === want) return seen;
    await new Promise((r) => setTimeout(r, 10));
  } while (Date.now() < deadline);
  return seen;
}

describe('deriveRunStatus with the running vocabulary', () => {
  it('orders suspended > failed > running > completed, and keeps the legacy answer', () => {
    expect(deriveRunStatus(true, { status: 'running' })).toBe('suspended'); // waiting beats started
    expect(deriveRunStatus(false, { status: 'failed' })).toBe('failed');
    expect(deriveRunStatus(false, { status: 'running' })).toBe('running');
    expect(deriveRunStatus(false, { status: 'completed' })).toBe('completed');
    // A journal with NO outcome — written before outcomes existed — reads exactly as it always did.
    expect(deriveRunStatus(false, null)).toBe('completed');
    expect(deriveRunStatus(false, undefined)).toBe('completed');
  });
});

describe('the write-ahead start marker', () => {
  it('a run abandoned mid-work reads running, not completed', async () => {
    const journal = new InMemoryStorage().runs;
    // A model that never returns — the process is then killed. In-process, "killed" is simply that
    // nothing after this point ever runs: we start the run and abandon the promise.
    const never = { ...base, doGenerate: () => new Promise(() => { /* SIGKILL lands here */ }) } as any;
    void runDurable({ runId: 'abandoned', journal, model: never, prompt: 'x' } as any).catch(() => {});

    expect(await waitForStatus(journal, 'abandoned', 'running'), 'this used to read completed').toBe('running');
    const outcome = await readRunOutcome(journal, 'abandoned');
    expect(outcome?.status).toBe('running');
  });

  it('a run that finishes overwrites its start with the verdict — both of them', async () => {
    const journal = new InMemoryStorage().runs;
    await runDurable({ runId: 'ok', journal, model: good, prompt: 'x' } as any);
    expect(await statusOf(journal, 'ok')).toBe('completed');

    await runDurable({ runId: 'bad', journal, model: dead, prompt: 'x' } as any).catch(() => {});
    expect(await statusOf(journal, 'bad')).toBe('failed');
  });

  it('a resume of a crashed run starts again and can finish it', async () => {
    const journal = new InMemoryStorage().runs;
    const never = { ...base, doGenerate: () => new Promise(() => {}) } as any;
    void runDurable({ runId: 'r', journal, model: never, prompt: 'x' } as any).catch(() => {});
    expect(await waitForStatus(journal, 'r', 'running')).toBe('running');

    // The operator resumes with a working model; the run truly ends this time.
    await runDurable({ runId: 'r', journal, model: good, prompt: 'x' } as any);
    expect(await statusOf(journal, 'r'), 'the resume must be able to close a crashed run').toBe('completed');
  });

  it('a stale start cannot resurrect a finished run', async () => {
    const journal = new InMemoryStorage().runs;
    await runDurable({ runId: 'done', journal, model: good, prompt: 'x' } as any);
    const settled = await readRunOutcome(journal, 'done');
    expect(settled?.status).toBe('completed');

    // A parallel starter's write-ahead lands late, with an OLDER timestamp — monotonicity holds.
    await runStarted(journal, 'done', settled!.at - 60_000);
    expect(await statusOf(journal, 'done'), 'the verdict stands').toBe('completed');
  });

  it('a suspended run stays suspended — waiting beats started', async () => {
    const { tool } = await import('ai');
    const { z } = await import('zod');
    const journal = new InMemoryStorage().runs;
    const t = tool({ description: 'c', inputSchema: z.object({ amount: z.number() }), execute: async () => ({ ok: true }) });
    Object.assign(t, { sideEffect: true });
    const model = {
      ...base,
      doGenerate: async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'chargeCard', input: JSON.stringify({ amount: 1 }) }], finishReason: 'tool-calls', usage, warnings: [] };
        return { content: [{ type: 'text', text: 'done' }], finishReason: 'stop', usage, warnings: [] };
      },
    } as any;

    const res = await runDurable({
      runId: 'waiting', journal, model, tools: { chargeCard: t as any },
      guard: () => ({ action: 'require-approval', reason: 'human' }), prompt: 'charge',
    } as any);
    expect(res.interrupts.length).toBeGreaterThan(0);
    // The write-ahead exists (the run did start), but the STATUS is suspended — precedence, not absence.
    expect((await readRunOutcome(journal, 'waiting'))?.status).toBe('running');
    expect(await statusOf(journal, 'waiting')).toBe('suspended');
  });
});
