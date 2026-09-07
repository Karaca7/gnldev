// FAZ-8 — the critical preset's WORKFLOW coverage. Pinned: runId is required; a sideEffect step
// without recover is refused; tombstone rejection; the input fingerprint (one runId = one input, a
// resume with the SAME input is free); a concurrent twin gets RunBusyError; the lock is released on
// completion; non-critical behavior is unchanged.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { RunBusyError, RunSweptError, RunInputMismatchError } from '../src/errors.js';
import { readIdemLedger } from '../src/idem-ledger.js';

const wfDef = (steps: any[] = []) => ({
  async run(input: unknown) { return { got: input }; },
  build: () => steps,
});

const mk = (preset?: 'critical', wf: any = wfDef()) =>
  createGnl({ journal: new InMemoryJournal(), preset, workflows: { w: wf as any } });

describe('FAZ-8 critical × runWorkflow', () => {
  it('runId is required; non-critical keeps the old behavior (a warn plus a generated id)', async () => {
    await expect(mk('critical').runWorkflow('w', { a: 1 })).rejects.toThrow(/requires an explicit runId/);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await mk(undefined).runWorkflow('w', { a: 1 });
      expect(r.runId).toMatch(/^wf-w-/); // non-critical: loud fallback aynen
    } finally { warn.mockRestore(); }
  });

  it("a sideEffect step without recover is refused; with one it passes", async () => {
    const bad = wfDef([{ id: 'charge', run: async () => 1, durability: { sideEffect: true } }]);
    await expect(mk('critical', bad).runWorkflow('w', {}, { runId: 'cw1' })).rejects.toThrow(/sideEffect without recover/);
    const good = wfDef([{ id: 'charge', run: async () => 1, durability: { sideEffect: true, recover: async () => ({ done: false }) } }]);
    await expect(mk('critical', good).runWorkflow('w', {}, { runId: 'cw2' })).resolves.toBeTruthy();
  });

  it('input fingerprint: the same runId with a different input → the 409 class; a resume with the SAME input is free; a ledger entry is written', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: wfDef() as any } });
    await gnl.runWorkflow('w', { q: 'A' }, { runId: 'fp1' });
    await expect(gnl.runWorkflow('w', { q: 'B' }, { runId: 'fp1' })).rejects.toBeInstanceOf(RunInputMismatchError);
    await expect(gnl.runWorkflow('w', { q: 'A' }, { runId: 'fp1' })).resolves.toBeTruthy(); // replay/resume is legitimate
    const ledger = await readIdemLedger(journal, { runId: 'fp1' });
    expect(ledger.some((r) => r.code === 'run_input_mismatch')).toBe(true);
  });

  it('tombstone rejection: a swept id cannot be run again', async () => {
    const journal = new InMemoryJournal();
    await journal.put('tb1:swept', { at: 1 });
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: wfDef() as any } });
    await expect(gnl.runWorkflow('w', {}, { runId: 'tb1' })).rejects.toBeInstanceOf(RunSweptError);
  });

  it('concurrent twins: the loser gets RunBusyError, and the lock is released on completion (a sequential resume works)', async () => {
    const journal = new InMemoryJournal();
    const slow = {
      async run(input: unknown) { await new Promise((r) => setTimeout(r, 60)); return { got: input }; },
      build: () => [],
    };
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: slow as any } });
    const [a, b] = await Promise.allSettled([
      gnl.runWorkflow('w', { x: 1 }, { runId: 'tw1' }),
      gnl.runWorkflow('w', { x: 1 }, { runId: 'tw1' }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual(['fulfilled', 'rejected']);
    const loser = (a.status === 'rejected' ? a : b) as PromiseRejectedResult;
    expect(loser.reason).toBeInstanceOf(RunBusyError);
    await expect(gnl.runWorkflow('w', { x: 1 }, { runId: 'tw1' })).resolves.toBeTruthy(); // the lock did not leak
  });
});

// Findings from the FAZ-8 audit — the resume escapes (BLOCKER), the combinator runtime net, and K4's claim turn.
import { workflow, step } from '@gnldev/workflow';

describe('FAZ-8 audit fixes', () => {
  it('BLOCKER: a suspended critical workflow can be approved the way the REAL resume surface does it — WITHOUT sending the input', async () => {
    const suspending = {
      async run() { return 1; },
      build: () => [],
      async runResumable(_input: unknown, _ctx: unknown, o?: { resume?: Record<string, unknown> }) {
        if (o?.resume?.ok === undefined) return { status: 'suspended' as const, stepId: 's1', waitId: 'ok' };
        return { status: 'completed' as const, output: { approved: o.resume.ok } };
      },
    };
    const gnl = createGnl({ journal: new InMemoryJournal(), preset: 'critical', workflows: { w: suspending as any } });
    const first = await gnl.runWorkflow('w', { q: 'A' }, { runId: 'rs1' });
    expect(first.suspended).toBe(true);
    // The Studio inbox / server resume route carries no input — the old code threw RunInputMismatchError here:
    const resumed = await gnl.runWorkflow('w', undefined, { runId: 'rs1', resume: { ok: true } });
    expect(resumed.output).toEqual({ approved: true });
    // A call CARRYING opts.resume is a resume intent too, even when it also carries an input:
    await expect(gnl.runWorkflow('w', { q: 'FARKLI' }, { runId: 'rs1', resume: { ok: true } })).resolves.toBeTruthy();
    // But a different-input call WITHOUT resume intent is still the 409 class:
    await expect(gnl.runWorkflow('w', { q: 'FARKLI' }, { runId: 'rs1' })).rejects.toBeInstanceOf(RunInputMismatchError);
  });

  it('the combinator runtime net: a recover-less sideEffect step inside parallel slips past the build gate but is refused at RUNTIME', async () => {
    const wf = workflow<number>().parallel(
      [step('charge', async () => ({ ok: 1 }), { sideEffect: true })], // NO recover — build() cannot see this one
      'par',
    );
    const gnl = createGnl({ journal: new InMemoryJournal(), preset: 'critical', workflows: { w: wf as any } });
    await expect(gnl.runWorkflow('w', 1, { runId: 'cn1' })).rejects.toThrow(/strictSideEffects.*charge/s);
    // The same workflow is free under non-critical (the opt-in contract):
    const free = createGnl({ journal: new InMemoryJournal(), workflows: { w: wf as any } });
    await expect(free.runWorkflow('w', 1, { runId: 'cn2' })).resolves.toBeTruthy();
  });

  it('K4: the DIFFERENT input that loses the fingerprint claim race gets a 409 against the winner\'s hash', async () => {
    const inner = new InMemoryJournal();
    let firstGet = true;
    const journal: any = new Proxy(inner, {
      get: (t, p) => {
        if (p === 'get') return async (k: string) => {
          if (k.endsWith(':wf:_input') && firstGet) { firstGet = false; return undefined; } // the race window
          return inner.get(k);
        };
        const val = (t as any)[p];
        return val instanceof Function ? val.bind(t) : val;
      },
    });
    // The winner (input X) has already written the claim:
    const { argsHash } = await import('../src/hash.js');
    await inner.put('k4:wf:_input', { hash: argsHash({ q: 'X' }), at: 1 });
    const gnl = createGnl({ journal, preset: 'critical', workflows: { w: { async run(i: unknown) { return i; }, build: () => [] } as any } });
    // The loser (input Y): sees undefined → claim false → re-reads → mismatches the winner → 409
    await expect(gnl.runWorkflow('w', { q: 'Y' }, { runId: 'k4' })).rejects.toBeInstanceOf(RunInputMismatchError);
  });
});
