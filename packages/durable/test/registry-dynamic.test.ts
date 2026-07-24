// C1 requestContext DI + C2 deterministic model fallback.
// - Dynamic system/tools: resolved via opts.context; the resolved system freezes into `:input` (replayable).
// - Fallback chain: the winner is written to `<runId>:cfg:model` via CAS; on resume, not the chain but
//   ONLY the winner is tried (even if the primary model recovers) → deterministic stickiness.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

function capturingModel(text: string, seen: { calls: any[] }) {
  return createMockModel(async (options: any) => {
    seen.calls.push(options);
    return finalTextResult(text);
  });
}

function failingModel(counter: { calls: number }) {
  return createMockModel(async () => {
    counter.calls++;
    throw new Error('provider down');
  });
}

describe('registry: requestContext DI', () => {
  it('dynamic system + tools are resolved via context; system freezes into :input', async () => {
    const journal = new InMemoryJournal();
    const seen = { calls: [] as any[] };
    const gnl = createGnl({
      journal,
      agents: {
        assistant: {
          model: capturingModel('done', seen),
          system: (ctx) => `You are an assistant for the ${ctx.org} organization.`,
          tools: (ctx) =>
            ctx.role === 'admin'
              ? { adminTool: tool({ description: 'admin only', inputSchema: z.object({}), execute: async () => 'ok' }) }
              : {},
        },
      },
    });

    await gnl.run('assistant', { runId: 'dyn-1', prompt: 'hello', context: { org: 'acme', role: 'admin' } });

    // The model call saw the dynamic system + the admin tool was offered
    const opts = seen.calls[0];
    expect(JSON.stringify(opts.prompt)).toContain('acme organization');
    expect(JSON.stringify(opts.tools ?? [])).toContain('adminTool');
    // The resolved system froze into the journaled input → resume is self-contained + deterministic
    const input = await journal.get<{ system?: string }>(runKeys.input('dyn-1'));
    expect(input?.system).toContain('acme organization');
  });
});

describe('registry: deterministic model fallback (C2)', () => {
  it('primary fails → backup wins → the winner is journaled → resume tries only the winner', async () => {
    const journal = new InMemoryJournal();
    const fails = { calls: 0 };
    const seen = { calls: [] as any[] };
    const agents = {
      a: { model: [failingModel(fails), capturingModel('answer from backup', seen)] },
    };
    const gnl = createGnl({ journal, agents });

    const r1: any = await gnl.run('a', { runId: 'fb-1', prompt: 'hi' });
    expect(r1.text).toBe('answer from backup');
    expect(fails.calls).toBe(1); // primary tried once
    // The winner was frozen via CAS (object model → '#1' label)
    expect(await journal.get(runKeys.cfgModel('fb-1'))).toEqual({ spec: '#1' });

    // Resume (same runId): the model response is replayed from the journal; primary is NEVER retried
    const r2: any = await gnl.run('a', { runId: 'fb-1', prompt: 'hi' });
    expect(r2.text).toBe('answer from backup');
    expect(fails.calls).toBe(1); // still 1 — deterministic stickiness
  });

  it('if all candidates fail, the last error is thrown and cfg is not written', async () => {
    const journal = new InMemoryJournal();
    const f1 = { calls: 0 };
    const f2 = { calls: 0 };
    const gnl = createGnl({ journal, agents: { a: { model: [failingModel(f1), failingModel(f2)] } } });
    await expect(gnl.run('a', { runId: 'fb-2', prompt: 'x' })).rejects.toThrow('provider down');
    expect(f1.calls).toBeGreaterThan(0);
    expect(f2.calls).toBeGreaterThan(0);
    expect(await journal.get(runKeys.cfgModel('fb-2'))).toBeUndefined();
  });
});
