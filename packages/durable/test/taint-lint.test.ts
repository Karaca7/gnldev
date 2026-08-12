// `untrusted` defaults to falsy, so a run that sets
// limits.taintedSideEffects but marks NO tool `untrusted: true` (and wires no tool-result processor) has a
// taint ladder that can never fire — configured, armed, inert. durableTools now emits a LOUD one-time warn
// naming exactly this, so the misconfiguration is visible instead of silently ineffective.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

const canNeverFire = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter((c) => String(c[0]).includes('can NEVER FIRE'));

function tools({ untrusted }: { untrusted: boolean }) {
  const fetchPage = tool({
    description: 'fetch external content',
    inputSchema: z.object({ url: z.string() }),
    execute: async () => ({ html: 'x' }),
  });
  if (untrusted) (fetchPage as any).untrusted = true;
  const sendMoney = tool({
    description: 'side effect',
    inputSchema: z.object({ iban: z.string() }),
    execute: async () => ({ sent: true }),
  });
  return { fetchPage, sendMoney };
}

const model = () => createMockModel(async () => finalTextResult('done'));

describe('A2 — taint configured but no untrusted source', () => {
  it('WARNS when taintedSideEffects is set but no tool is untrusted and no processor is wired', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDurable({
      runId: 'a2-1', journal: new InMemoryJournal(), model: model(),
      tools: tools({ untrusted: false }), prompt: 'go',
      stopWhen: stepCountIs(3), limits: { taintedSideEffects: 'block' },
    } as any);
    expect(canNeverFire(warn)).toHaveLength(1);
  });

  it('does NOT warn when a tool IS marked untrusted (the ladder has a source)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDurable({
      runId: 'a2-2', journal: new InMemoryJournal(), model: model(),
      tools: tools({ untrusted: true }), prompt: 'go',
      stopWhen: stepCountIs(3), limits: { taintedSideEffects: 'block' },
    } as any);
    expect(canNeverFire(warn)).toHaveLength(0);
  });

  it('does NOT warn when taintedSideEffects is off/unset', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDurable({
      runId: 'a2-3', journal: new InMemoryJournal(), model: model(),
      tools: tools({ untrusted: false }), prompt: 'go', stopWhen: stepCountIs(3),
    } as any);
    expect(canNeverFire(warn)).toHaveLength(0);
  });

  it('warns ONCE per store even across multiple runs (once-per-store WeakSet)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    for (const runId of ['a2-a', 'a2-b']) {
      await runDurable({
        runId, journal, model: model(), tools: tools({ untrusted: false }), prompt: 'go',
        stopWhen: stepCountIs(3), limits: { taintedSideEffects: 'suspend' },
      } as any);
    }
    expect(canNeverFire(warn)).toHaveLength(1);
  });
});
