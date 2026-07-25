// P1.4 (AUDIT-R2) — evalDataset concurrency/timeout/retry. Default (no `concurrency` given)
// must remain byte-identical to the pre-P1.4 sequential `for` loop (dataset.test.ts already covers
// that baseline); these tests cover the NEW behavior: concurrency actually parallelizes, a per-case
// timeout fails only that case (not the whole suite), and crash-resume memoization survives both.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { evalDataset, contains, type Dataset } from '../src/index.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DELAY_MS = 40;

function delayedDataset(n: number): Dataset {
  return { id: `delayed-${n}`, cases: Array.from({ length: n }, (_, i) => ({ id: `c${i}`, input: `in${i}`, expected: `echo:in${i}` })) };
}

describe('@gnldev/evals evalDataset — concurrency (P1.4)', () => {
  it('default concurrency (1) preserves exact case order and result content', async () => {
    const dataset = delayedDataset(3);
    const order: string[] = [];
    const res = await evalDataset({
      dataset,
      run: async (input, ctx) => {
        order.push(ctx.caseId);
        return `echo:${input}`;
      },
      scorers: [contains('echo')],
    });
    expect(order).toEqual(['c0', 'c1', 'c2']); // strictly sequential, dataset order
    expect(res.cases.map((c) => c.caseId)).toEqual(['c0', 'c1', 'c2']);
    expect(res.aggregate['contains']).toBe(1);
  });

  it('concurrency > 1 runs cases in parallel — wall time close to one delay, not N delays', async () => {
    const n = 4;
    const dataset = delayedDataset(n);
    const run = async (input: any) => {
      await sleep(DELAY_MS);
      return `echo:${input}`;
    };

    const t0 = Date.now();
    await evalDataset({ dataset, run, scorers: [contains('echo')], concurrency: n });
    const parallelMs = Date.now() - t0;

    const t1 = Date.now();
    await evalDataset({ dataset, run, scorers: [contains('echo')], concurrency: 1 });
    const serialMs = Date.now() - t1;

    // parallel run of n cases at DELAY_MS each should take roughly 1x DELAY_MS, serial roughly nx.
    // Generous margin to avoid flakiness: parallel must be meaningfully faster than serial.
    expect(parallelMs).toBeLessThan(serialMs * 0.7);
  });

  it('result order stays index-aligned to dataset.cases regardless of completion order under concurrency', async () => {
    const dataset = delayedDataset(4);
    // reverse-delay: earlier cases finish LAST, to prove results aren't just completion-order.
    const run = async (input: any, ctx: { caseId: string }) => {
      const idx = Number(ctx.caseId.slice(1));
      await sleep((dataset.cases.length - idx) * 15);
      return `echo:${input}`;
    };
    const res = await evalDataset({ dataset, run, scorers: [contains('echo')], concurrency: 4 });
    expect(res.cases.map((c) => c.caseId)).toEqual(['c0', 'c1', 'c2', 'c3']);
  });

  it('a per-case timeout fails only that case; other cases still succeed (no suite abort)', async () => {
    const dataset: Dataset = {
      id: 'timeout-ds',
      cases: [
        { id: 'fast', input: 'a', expected: 'echo:a' },
        { id: 'slow', input: 'b', expected: 'echo:b' },
        { id: 'fast2', input: 'c', expected: 'echo:c' },
      ],
    };
    const run = async (input: any, ctx: { caseId: string }) => {
      if (ctx.caseId === 'slow') await sleep(200);
      return `echo:${input}`;
    };

    const res = await evalDataset({ dataset, run, scorers: [contains('echo')], itemTimeoutMs: 30 });

    const slow = res.cases.find((c) => c.caseId === 'slow')!;
    expect(slow.error).toBeDefined();
    expect(slow.scores).toEqual({});

    const fast = res.cases.find((c) => c.caseId === 'fast')!;
    const fast2 = res.cases.find((c) => c.caseId === 'fast2')!;
    expect(fast.error).toBeUndefined();
    expect(fast.scores['contains']!.score).toBe(1);
    expect(fast2.error).toBeUndefined();
    expect(fast2.scores['contains']!.score).toBe(1);

    // aggregate reflects the failed case as 0, not an abort/throw
    expect(res.aggregate['contains']).toBeCloseTo(2 / 3);
  });

  it('maxRetries: a case that fails once then succeeds is retried, ends up successful', async () => {
    const dataset: Dataset = { id: 'retry-ds', cases: [{ id: 'flaky', input: 'x', expected: 'echo:x' }] };
    let attempts = 0;
    const run = async (input: any) => {
      attempts++;
      if (attempts < 2) throw new Error('transient failure');
      return `echo:${input}`;
    };

    const res = await evalDataset({ dataset, run, scorers: [contains('echo')], maxRetries: 2 });
    expect(attempts).toBe(2);
    expect(res.cases[0]!.error).toBeUndefined();
    expect(res.cases[0]!.scores['contains']!.score).toBe(1);
  });

  it('maxRetries exhausted: case ends as a recorded failure, not a thrown suite-level error', async () => {
    const dataset: Dataset = { id: 'always-fails-ds', cases: [{ id: 'broken', input: 'x' }] };
    let attempts = 0;
    const run = async () => {
      attempts++;
      throw new Error('permanent failure');
    };

    const res = await evalDataset({ dataset, run, scorers: [contains('echo')], maxRetries: 1 });
    expect(attempts).toBe(2); // initial attempt + 1 retry
    expect(res.cases[0]!.error).toContain('permanent failure');
  });

  it('crash-resume memoization still holds under concurrency: a second evalDataset call re-runs nothing', async () => {
    const journal = new InMemoryJournal();
    const dataset = delayedDataset(5);
    let runs = 0;
    const run = async (input: any) => {
      runs++;
      await sleep(5);
      return `echo:${input}`;
    };

    const r1 = await evalDataset({ dataset, run, scorers: [contains('echo')], journal, concurrency: 3 });
    expect(runs).toBe(5);
    expect(r1.aggregate['contains']).toBe(1);

    const r2 = await evalDataset({ dataset, run, scorers: [contains('echo')], journal, concurrency: 3 });
    expect(runs).toBe(5); // unchanged — every case was memoized, none re-ran
    expect(r2.cases.map((c) => c.caseId)).toEqual(r1.cases.map((c) => c.caseId));
    expect(r2.aggregate['contains']).toBe(1);
  });
});
