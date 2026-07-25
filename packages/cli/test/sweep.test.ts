// gnl sweep: previewSweepCore (dry-run, never deletes) + sweepRunsCore (the real @gnldev/durable sweepRuns).
import { describe, it, expect, vi, afterEach } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { previewSweepCore, sweepRunsCore } from '../src/commands/sweep.js';
import { agentModel } from './helpers.js';

const DAY = 86_400_000;

describe('sweep', () => {
  it('preview lists stale runs without deleting anything; keeps suspended by default', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'old-1', journal, model: agentModel('t', 'c1', {}, 'done'), tools: { t: { execute: async () => ({}) } }, prompt: 'p' });
    await runDurable({
      runId: 'old-suspended',
      journal,
      model: agentModel('t', 'c2', {}),
      tools: { t: { execute: async () => ({}) } },
      guard: () => ({ action: 'require-approval' }),
      prompt: 'p',
    });
    const t0 = Date.now();
    const now = t0 + 40 * DAY; // pretend 40 days have passed

    const preview = await previewSweepCore({ journal } as any, Durable, { olderThanMs: 30 * DAY, keepSuspended: true, now });
    expect(preview.wouldPurge.map((r) => r.runId)).toEqual(['old-1']);
    expect(preview.keptSuspended).toBe(1);

    // dry-run never mutates
    expect((await journal.readRun('old-1')).length).toBeGreaterThan(0);
    expect((await journal.readRun('old-suspended')).length).toBeGreaterThan(0);
  });

  it('--include-suspended (keepSuspended:false) sweeps a stale suspended run too', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'old-suspended',
      journal,
      model: agentModel('t', 'c2', {}),
      tools: { t: { execute: async () => ({}) } },
      guard: () => ({ action: 'require-approval' }),
      prompt: 'p',
    });
    const now = Date.now() + 40 * DAY;
    const preview = await previewSweepCore({ journal } as any, Durable, { olderThanMs: 30 * DAY, keepSuspended: false, now });
    expect(preview.wouldPurge.map((r) => r.runId)).toEqual(['old-suspended']);
  });

  it('the real sweep (sweepRunsCore) actually deletes what preview predicted', async () => {
    // Fake timers to give 'old-2' and 'fresh-1' genuinely different ages (InMemoryJournal timestamps
    // real wall-clock writes — without this both runs would look equally "old" relative to `now`).
    const t0 = Date.now();
    vi.useFakeTimers();
    try {
      vi.setSystemTime(t0);
      const journal = new InMemoryJournal();
      await runDurable({ runId: 'old-2', journal, model: agentModel('t', 'c1', {}, 'done'), tools: { t: { execute: async () => ({}) } }, prompt: 'p' });

      vi.setSystemTime(t0 + 35 * DAY);
      await runDurable({ runId: 'fresh-1', journal, model: agentModel('t', 'c3', {}, 'done'), tools: { t: { execute: async () => ({}) } }, prompt: 'p' });

      const now = t0 + 40 * DAY;
      const result = await sweepRunsCore({ journal } as any, Durable, { olderThanMs: 30 * DAY, keepSuspended: true, now });
      expect(result.purged).toEqual(['old-2']);
      expect((await journal.readRun('old-2')).length).toBe(0);
      expect((await journal.readRun('fresh-1')).length).toBeGreaterThan(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
});
