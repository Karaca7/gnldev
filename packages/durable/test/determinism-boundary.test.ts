// M2 — Determinism boundary + replay hardening.
// (a) non-det tool body on resume: SAME value + runs once · (b) on full resume the live model is NOT
// consumed again (the chain replays from the journal) · (c) HONEST boundary: the tail AFTER the crash point runs LIVE ·
// (d) strict drift → DivergenceError, lenient → only a warning.

import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';
import { runDurable } from '../src/run.js';
import { DivergenceError } from '../src/errors.js';
import { countToolResults, toolCallResult, finalTextResult, createMockModel } from './mock.js';

describe('M2 determinism boundary', () => {
  it('(a) non-det tool body: resume returns the same journaled value, body runs once', async () => {
    const journal = new InMemoryJournal();
    let bodyCalls = 0;
    const tools = {
      now: {
        // deliberately non-deterministic: an increasing value on each call
        execute: async () => ({ ts: ++bodyCalls * 1000 }),
      },
    };
    const model = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0
          ? toolCallResult('now', 'call-now', {})
          : finalTextResult('done'),
      );

    await runDurable({ runId: 'r', journal, model: model(), tools, stopWhen: stepCountIs(6), prompt: 'x' });
    const after1 = await journal.get('r:tool:call-now');
    expect(bodyCalls).toBe(1);

    // Repeat with the same runId (resume): the tool replays from the journal → the body does NOT run again, the value stays fixed.
    await runDurable({ runId: 'r', journal, model: model(), tools, stopWhen: stepCountIs(6), prompt: 'x' });
    expect(bodyCalls).toBe(1);
    expect(await journal.get('r:tool:call-now')).toEqual(after1);
  });

  it('(b) full resume: the live model is NOT CONSUMED; the tool-call chain replays from the journal', async () => {
    const journal = new InMemoryJournal();
    let gen = 0; // shared closure: increments if the live model is called
    const model = createMockModel(async ({ prompt }: any) => {
      if (countToolResults(prompt) === 0) {
        gen++;
        return toolCallResult('peek', `call-${gen}`, { n: gen });
      }
      return finalTextResult('ok');
    });
    let bodyCalls = 0;
    const tools = { peek: { execute: async () => ++bodyCalls } };

    const r1 = await runDurable({ runId: 'r', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'x' });
    expect(gen).toBe(1); // live once in run1 (step0)
    expect(await journal.get('r:tool:call-1')).toBeDefined();

    // Resume: SAME model instance. All steps replay from the journal → doGenerate is NEVER called → gen=1.
    const r2 = await runDurable({ runId: 'r', journal, model, tools, stopWhen: stepCountIs(6), prompt: 'x' });
    expect(gen).toBe(1); // the live model was not consumed on resume → the chain was replayed (call-2 was NOT produced)
    expect(bodyCalls).toBe(1);
    expect(r2.text).toBe(r1.text);
  });

  it('(c) honest boundary: the tail AFTER the crash runs LIVE (replay covers only the prefix)', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    const live = { n: 0 };
    const tools = { charge: { execute: async () => ({ charged: (charges.n++, 20) }) } };
    const makeModel = (crash: { active: boolean }, phase: { label: string }) =>
      createMockModel(async ({ prompt }: any) => {
        const done = countToolResults(prompt);
        if (done === 0) return toolCallResult('charge', 'call-c', { amount: 20 });
        if (crash.active && done === 1) throw new Error('CRASH');
        live.n++;
        return finalTextResult(`done-${phase.label}`);
      });

    // Run1: the charge HAPPENS, then it crashes (the final step is never reached).
    await expect(
      runDurable({
        runId: 'r', journal, model: makeModel({ active: true }, { label: 'A' }),
        tools, stopWhen: stepCountIs(6), prompt: 'x',
      }),
    ).rejects.toThrow('CRASH');
    expect(charges.n).toBe(1);
    expect(live.n).toBe(0);

    // Run2: no crash, phase 'B'. Prefix (charge) replays → single charge; tail is LIVE → text is 'B'.
    const r2 = await runDurable({
      runId: 'r', journal, model: makeModel({ active: false }, { label: 'B' }),
      tools, stopWhen: stepCountIs(6), prompt: 'x',
    });
    expect(charges.n).toBe(1); // prefix exactly-once
    expect(live.n).toBe(1); // the tail ACTUALLY ran live
    expect(r2.text).toBe('done-B'); // NOT 'A' → no fake "same output" guarantee
  });

  it('(d) strict drift → DivergenceError; lenient → only a warning, returns the recorded output', async () => {
    // Plant a prior succeeded record (with a mismatched argsHash) → force drift.
    const seed = () => {
      const j = new InMemoryJournal();
      return j.put('r:tool:call-x', { status: 'succeeded', output: { ok: true }, argsHash: 'DEADBEEF' }).then(() => j);
    };

    const jStrict = await seed();
    let strictRan = 0;
    const dtStrict = durableTool(
      { execute: async () => (strictRan++, 'SHOULD-NOT-RUN') },
      { journal: jStrict, runId: 'r', replay: 'strict' },
      'peek',
    );
    await expect(dtStrict.execute!({ n: 1 }, { toolCallId: 'call-x' })).rejects.toThrow(DivergenceError);
    expect(strictRan).toBe(0);

    const jLenient = await seed();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let lenientRan = 0;
    const dtLenient = durableTool(
      { execute: async () => (lenientRan++, 'SHOULD-NOT-RUN') },
      { journal: jLenient, runId: 'r' }, // default lenient
      'peek',
    );
    const out = await dtLenient.execute!({ n: 1 }, { toolCallId: 'call-x' });
    expect(out).toEqual({ ok: true }); // the recorded output is returned (the body doesn't run)
    expect(lenientRan).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });
});
