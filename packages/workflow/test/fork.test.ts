// Forking a workflow run at a step — the wiring the substrate was already carrying.
//
// Every step's output has always been journaled exactly-once under `<runId>:wf:<stepId>`; what was
// missing was only the copy that makes a second timeline. The neighbours have had this for a while
// (forking from a checkpoint with the prefix served from storage, or resuming a run from a
// chosen step off a snapshot), and the question that surfaced it was fair: "bu neden
// olmasın ki?" — there was no reason.
import { describe, it, expect } from 'vitest';
import { workflow, step, forkWorkflowRun, type JournalLike } from '../src/index.js';

function memJournal(): JournalLike & { dump(): Map<string, unknown> } {
  const m = new Map<string, unknown>();
  return {
    get: async (k) => m.get(k) as any,
    put: async (k, v) => { m.set(k, v); },
    putIfAbsent: async (k, v) => (m.has(k) ? false : (m.set(k, v), true)),
    listKeys: async (p) => [...m.keys()].filter((k) => k.startsWith(p)),
    dump: () => m,
  };
}

/** Three steps that count their own executions, so "replayed" vs "re-run" is observable. */
function build(counts: Record<string, number>, opts: { flaky?: boolean } = {}) {
  const bump = (id: string) => { counts[id] = (counts[id] ?? 0) + 1; };
  return workflow()
    .then(step('fetch', async (input: any) => { bump('fetch'); return { order: input.orderId }; }))
    .then(step('decide', async (prev: any) => { bump('decide'); return { ...prev, approved: !opts.flaky }; }))
    .then(step('notify', async (prev: any) => { bump('notify'); return { ...prev, sent: true }; }));
}

describe('forking a workflow run', () => {
  it('replays the prefix from the record and re-runs from the fork step', async () => {
    const journal = memJournal();
    const counts: Record<string, number> = {};
    const wf = build(counts);
    await wf.run({ orderId: '8812' }, { runId: 'src', journal });
    expect(counts).toEqual({ fetch: 1, decide: 1, notify: 1 });

    await forkWorkflowRun(journal, wf, 'src', 'decide', 'fork-1');
    const out = await build(counts).run({ orderId: 'ignored' }, { runId: 'fork-1', journal });

    // `fetch` was served from the copied record — its body never ran again. Everything from the
    // fork step on executed for real.
    expect(counts.fetch).toBe(1);
    expect(counts.decide).toBe(2);
    expect(counts.notify).toBe(2);
    // And the prefix's DATA carried over: the fork still knows the original order.
    expect(out).toEqual({ order: '8812', approved: true, sent: true });
  });

  it('is the experiment primitive: change a later step, keep the same prefix', async () => {
    // The whole point of a bench fork — "same first half, different second half, what differs?".
    const journal = memJournal();
    const counts: Record<string, number> = {};
    await build(counts).run({ orderId: '8812' }, { runId: 'src', journal });

    await forkWorkflowRun(journal, build(counts), 'src', 'decide', 'fork-flaky');
    const out = await build(counts, { flaky: true }).run({}, { runId: 'fork-flaky', journal });

    expect(out).toMatchObject({ order: '8812', approved: false });
  });

  it('refuses a step the workflow does not have, naming the ones it does', async () => {
    const journal = memJournal();
    await expect(forkWorkflowRun(journal, build({}), 'src', 'ghost', 'f'))
      .rejects.toThrow(/step 'ghost'.*fetch → decide → notify/s);
  });

  it('refuses a destination that already holds a run — a merge is not a fork', async () => {
    const journal = memJournal();
    const counts: Record<string, number> = {};
    const wf = build(counts);
    await wf.run({ orderId: '1' }, { runId: 'a', journal });
    await wf.run({ orderId: '2' }, { runId: 'b', journal });

    await expect(forkWorkflowRun(journal, wf, 'a', 'decide', 'b'))
      .rejects.toThrow(/already has (?:a workflow run|step records)/);
  });

  it('writes a registry record that says where the fork came from', async () => {
    // A fork nobody can trace to its source is just an unexplained run.
    const journal = memJournal();
    const wf = build({});
    await wf.run({ orderId: '1' }, { runId: 'src', journal });
    await forkWorkflowRun(journal, wf, 'src', 'notify', 'f1');

    expect(await journal.get('wfrun:f1')).toMatchObject({
      status: 'forked', forkedFrom: { runId: 'src', fromStepId: 'notify' },
    });
  });
});
