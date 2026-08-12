// 8.6 createGnl (registry/DI) + model('provider/model') router.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { resolveModel } from '../src/model-router.js';
import { RunBusyError } from '../src/errors.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

describe('createGnl + model router (8.6)', () => {
  it('registered agent runs durably', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: {
        support: { model: createMockModel(async () => finalTextResult('hello')), system: 'Be helpful' },
      },
    });
    const res = await gnl.run('support', { prompt: 'hi', runId: 's1' });
    expect(res.text).toBe('hello');
  });

  it('unknown agent -> error', async () => {
    const gnl = createGnl({ journal: new InMemoryJournal() });
    await expect(gnl.run('nope', { prompt: 'x', runId: 'r' })).rejects.toThrow('is not registered');
  });

  it('model router: provider/model parse + error paths', async () => {
    await expect(resolveModel('justmodel')).rejects.toThrow(/provider\/model/);
    await expect(resolveModel('bogus/x')).rejects.toThrow(/Unknown provider/);
  });

  // RunOptions.lock MUST be
  // forwarded to runDurable through gnl.run. If it isn't, two concurrent runs of the same runId emit
  // DIFFERENT toolCallIds (this test mimics that: call-A vs call-B) → the toolCallId-keyed claim lets
  // both through → DOUBLE side-effect. The lock serializes the run: only one runs, the other gets RunBusyError.
  it('opts.lock is forwarded: concurrent same runId → one RunBusyError, side-effect EXACTLY 1 (with distinct toolCallIds)', async () => {
    const journal = new InMemoryJournal();
    let charges = 0;
    const charge = tool({
      description: 'charge', inputSchema: z.object({}),
      execute: async () => { charges++; await new Promise((r) => setTimeout(r, 60)); return { ok: true }; },
    });
    // Each worker's model emits a DISTINCT toolCallId → without the lock, the tool-claim lets both through.
    const model = (id: string) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', `call-${id}`, {}) : finalTextResult('done'));
    const gnl = createGnl({ journal, agents: { pay: { model: model('A'), tools: { charge }, maxSteps: 4 } } });
    // Two concurrent gnl.run, SAME runId, locked.
    const opts = (owner: string) => ({ runId: 'race-1', prompt: 'x', lock: { owner, ttlMs: 5000 } });
    const gnlB = createGnl({ journal, agents: { pay: { model: model('B'), tools: { charge }, maxSteps: 4 } } });
    const settled = await Promise.allSettled([gnl.run('pay', opts('A') as any), gnlB.run('pay', opts('B') as any)]);
    const busy = settled.filter((s) => s.status === 'rejected' && (s as PromiseRejectedResult).reason instanceof RunBusyError);
    expect(busy.length).toBe(1); // the lock eliminated exactly one
    expect(charges).toBe(1); // side-effect exactly-once (would be 2 if the lock weren't forwarded)
  });

  it('without a lock, distinct toolCallIds on the same runId → the tool-claim is not enough (negative proof for why the lock is required)', async () => {
    const journal = new InMemoryJournal();
    let charges = 0;
    const charge = tool({
      description: 'charge', inputSchema: z.object({}),
      execute: async () => { charges++; await new Promise((r) => setTimeout(r, 60)); return { ok: true }; },
    });
    const model = (id: string) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', `call-${id}`, {}) : finalTextResult('done'));
    const gnl = createGnl({ journal, agents: { pay: { model: model('A'), tools: { charge }, maxSteps: 4 } } });
    const gnlB = createGnl({ journal, agents: { pay: { model: model('B'), tools: { charge }, maxSteps: 4 } } });
    // No lock → distinct toolCallIds (call-A/call-B) are separate journal keys → both execute.
    await Promise.allSettled([
      gnl.run('pay', { runId: 'race-2', prompt: 'x' } as any),
      gnlB.run('pay', { runId: 'race-2', prompt: 'x' } as any),
    ]);
    expect(charges).toBe(2); // DOCUMENTED BOUND: without a lock, distinct toolCallIds are not deduped → the lock is REQUIRED
  });
});
