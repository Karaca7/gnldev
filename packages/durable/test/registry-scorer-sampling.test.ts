// P1.2 (AUDIT-R2): opt-in scorer sampling (AgentConfig.scorerSampling). Decision is
// DETERMINISTIC per runId (FNV-1a hash, NOT Math.random) — see registry.ts shouldSampleScorers.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

function mkGnl(journal: InMemoryJournal, rate: number, scorerRuns: { n: number }) {
  return createGnl({
    journal,
    agents: {
      a: {
        model: createMockModel(async () => finalTextResult('final answer')),
        scorers: [{ name: 'len', score: ({ output }) => { scorerRuns.n++; return { score: output.length }; } }],
        scorerSampling: { rate },
      },
    },
  });
}

describe('registry: scorer sampling (P1.2)', () => {
  it('rate=0 → never scores, no proc:eval journal write, deterministic across repeated calls', async () => {
    const journal = new InMemoryJournal();
    const scorerRuns = { n: 0 };
    const gnl = mkGnl(journal, 0, scorerRuns);

    const r1: any = await gnl.run('a', { runId: 'r-zero-1', prompt: 'x' });
    expect(r1.scores).toBeUndefined();
    expect(scorerRuns.n).toBe(0);
    expect(await journal.get('r-zero-1:proc:eval:len')).toBeUndefined();

    // different runId, same outcome (rate 0 always skips regardless of runId)
    const r2: any = await gnl.run('a', { runId: 'r-zero-2', prompt: 'x' });
    expect(r2.scores).toBeUndefined();
    expect(scorerRuns.n).toBe(0);
  });

  it('rate=1 → always scores (same as no scorerSampling at all)', async () => {
    const journal = new InMemoryJournal();
    const scorerRuns = { n: 0 };
    const gnl = mkGnl(journal, 1, scorerRuns);

    for (const runId of ['r-one-1', 'r-one-2', 'r-one-3']) {
      const r: any = await gnl.run('a', { runId, prompt: 'x' });
      expect(r.scores.len.score).toBe('final answer'.length);
    }
    expect(scorerRuns.n).toBe(3);
  });

  it('same runId always yields the same decision (replay/resume-safe) — repeated run() calls agree', async () => {
    const journal = new InMemoryJournal();
    const scorerRuns = { n: 0 };
    const gnl = mkGnl(journal, 0.5, scorerRuns);

    const r1: any = await gnl.run('a', { runId: 'stable-runid-for-determinism', prompt: 'x' });
    const decision1 = r1.scores !== undefined;

    // A second createGnl instance (fresh sampling WeakSet state, same algorithm) must agree — proves
    // the decision is a pure function of runId + rate, not incidental in-process state.
    const journal2 = new InMemoryJournal();
    const scorerRuns2 = { n: 0 };
    const gnl2 = mkGnl(journal2, 0.5, scorerRuns2);
    const r2: any = await gnl2.run('a', { runId: 'stable-runid-for-determinism', prompt: 'x' });
    const decision2 = r2.scores !== undefined;

    expect(decision2).toBe(decision1);
  });

  it('rate=0.5 over 200 synthetic runIds lands within 35-65% sampled-in', async () => {
    const journal = new InMemoryJournal();
    const scorerRuns = { n: 0 };
    const gnl = mkGnl(journal, 0.5, scorerRuns);

    let sampledIn = 0;
    for (let i = 0; i < 200; i++) {
      const r: any = await gnl.run('a', { runId: `synthetic-run-${i}`, prompt: 'x' });
      if (r.scores !== undefined) sampledIn++;
    }
    expect(sampledIn).toBeGreaterThanOrEqual(70); // 35%
    expect(sampledIn).toBeLessThanOrEqual(130); // 65%
  });

  it('a sampled-IN run is still memoized exactly once across resume/repeat calls', async () => {
    const journal = new InMemoryJournal();
    const scorerRuns = { n: 0 };
    // rate=1 to deterministically land "sampled in" without hunting for a runId that hashes in-bucket.
    const gnl = mkGnl(journal, 1, scorerRuns);

    const r1: any = await gnl.run('a', { runId: 'resume-sampled-in', prompt: 'x' });
    expect(r1.scores.len.score).toBe('final answer'.length);
    expect(scorerRuns.n).toBe(1);

    const r2: any = await gnl.run('a', { runId: 'resume-sampled-in', prompt: 'x' }); // replay/resume
    expect(r2.scores.len.score).toBe('final answer'.length);
    expect(scorerRuns.n).toBe(1); // exactly-once — scorer did NOT re-run
  });

  it('invalid rate (out of range) is treated as 1 (score every run) with a one-time console.warn, never throws', async () => {
    const journal = new InMemoryJournal();
    const scorerRuns = { n: 0 };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const gnl = createGnl({
        journal,
        agents: {
          a: {
            model: createMockModel(async () => finalTextResult('ok')),
            scorers: [{ name: 'len', score: ({ output }) => { scorerRuns.n++; return { score: output.length }; } }],
            scorerSampling: { rate: 5 }, // invalid (>1)
          },
        },
      });

      const r1: any = await gnl.run('a', { runId: 'invalid-rate-1', prompt: 'x' });
      expect(r1.scores.len.score).toBe('ok'.length);
      const r2: any = await gnl.run('a', { runId: 'invalid-rate-2', prompt: 'x' });
      expect(r2.scores.len.score).toBe('ok'.length);

      // warned, but only ONCE despite two runs sharing the same invalid config object
      expect(warnSpy).toHaveBeenCalledTimes(1);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('NaN rate also falls back to 1 without throwing', async () => {
    const journal = new InMemoryJournal();
    const scorerRuns = { n: 0 };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const gnl = createGnl({
        journal,
        agents: {
          a: {
            model: createMockModel(async () => finalTextResult('ok')),
            scorers: [{ name: 'len', score: ({ output }) => { scorerRuns.n++; return { score: output.length }; } }],
            scorerSampling: { rate: NaN },
          },
        },
      });
      const r: any = await gnl.run('a', { runId: 'nan-rate', prompt: 'x' });
      expect(r.scores.len.score).toBe('ok'.length);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
