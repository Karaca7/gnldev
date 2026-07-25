// gnl resume: resumeRunCore (pure) — a suspended (Guard require-approval) run progresses to completed
// once approved, using the agent config registered under gnl.config.ts's `agents`.
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryJournal, runDurable } from '@gnldev/durable';
import { resumeRunCore } from '../src/commands/resume.js';
import { agentModel } from './helpers.js';

describe('resumeRunCore', () => {
  it('a suspended run (awaiting approval) progresses to completed once approved', async () => {
    const journal = new InMemoryJournal();
    const model = agentModel('charge', 'call-1', { amount: 5000 }, 'Charged.');
    const charges = { n: 0 };
    const tools = { charge: { execute: async () => ({ charged: (charges.n++, 5000) }) } };
    const guard = () => ({ action: 'require-approval' as const });

    const r1 = await runDurable({ runId: 'appr-1', journal, model, tools, guard, prompt: 'large charge' });
    expect(r1.interrupts).toHaveLength(1);
    expect(charges.n).toBe(0);

    const config = { journal, agents: { biller: { model: agentModel('charge', 'call-1', { amount: 5000 }, 'Charged.'), tools, guard, maxSteps: 4 } } } as any;
    const result = await resumeRunCore(config, Durable, 'appr-1', 'biller', { approvals: { 'call-1': true } });

    expect(result.status).toBe('completed');
    expect(result.text).toBe('Charged.');
    expect(charges.n).toBe(1);
  });

  it('an agent that is not registered -> a clear error naming what IS registered', async () => {
    const journal = new InMemoryJournal();
    const config = { journal, agents: { real: { model: agentModel('x', 'y', {}) } } } as any;
    await expect(resumeRunCore(config, Durable, 'whatever', 'missing')).rejects.toThrow(/not found.*real/);
  });

  it('a run with no recorded input -> resumeRun\'s own "cannot resume" error surfaces', async () => {
    const journal = new InMemoryJournal();
    const config = { journal, agents: { a: { model: agentModel('x', 'y', {}) } } } as any;
    await expect(resumeRunCore(config, Durable, 'never-ran', 'a')).rejects.toThrow(/cannot resume/);
  });

  it('supports a string model spec resolved via the agent config (fallback chain path)', async () => {
    // Not exercising a real provider (no API key in tests) — just proving materializeModel's array
    // path is reachable: an unresolvable provider gives a CLEAR error, not a silent crash/hang.
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'x-1', journal, model: agentModel('t', 'c1', {}), tools: { t: { execute: async () => ({}) } }, prompt: 'p' });
    const config = { journal, agents: { bad: { model: 'not-a-real-provider/model-x' } } } as any;
    await expect(resumeRunCore(config, Durable, 'x-1', 'bad')).rejects.toThrow(/Unknown provider/);
  });
});
