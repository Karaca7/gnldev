// API-03: GET /workflows/runs?limit= — a bounded scan + a paged {items,nextCursor} envelope (same shape
// GET /runs?limit= already uses, see runs-paging.test.ts). Before this fix the route always `listKeys` +
// `get`-per-key'd EVERY `wfrun:*` record and returned a flat array with no `limit` at all — a 20k-run
// registry meant ~20k reads just to show a handful of suspended rows on every poll. `limit` omitted still
// returns the legacy flat array, unchanged (older callers, e.g. packages/server, never send `limit`).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

/** Seeds N `wfrun:` registry records (journal append order = oldest → newest, updatedAt = i). */
async function seedWfRuns(journal: InMemoryJournal, n: number, status: 'suspended' | 'completed' | 'canceled' = 'completed') {
  for (let i = 1; i <= n; i++) {
    await journal.put(`wfrun:run-${i}`, { runId: `run-${i}`, status, updatedAt: i });
  }
}

describe('GET /workflows/runs pagination (API-03)', () => {
  it('a call without `limit` returns the legacy flat array, unchanged', async () => {
    const journal = new InMemoryJournal();
    await seedWfRuns(journal, 3);
    const app = createStudioApi({ reader: journal });
    const res = await (await call(app, '/workflows/runs')).json();
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(3);
    expect(res.map((r: any) => r.runId)).toEqual(['run-3', 'run-2', 'run-1']); // newest (updatedAt) first
  });

  it('`limit` given returns a paged {items,nextCursor} envelope, newest-first, cursor advances correctly', async () => {
    const journal = new InMemoryJournal();
    await seedWfRuns(journal, 5);
    const app = createStudioApi({ reader: journal });

    const p1 = await (await call(app, '/workflows/runs?limit=2')).json();
    expect(p1.items.map((r: any) => r.runId)).toEqual(['run-5', 'run-4']);
    expect(p1.nextCursor).toBe('2');

    const p2 = await (await call(app, `/workflows/runs?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((r: any) => r.runId)).toEqual(['run-3', 'run-2']);
    expect(p2.nextCursor).toBe('4');

    const p3 = await (await call(app, `/workflows/runs?limit=2&cursor=${p2.nextCursor}`)).json();
    expect(p3.items.map((r: any) => r.runId)).toEqual(['run-1']);
    expect(p3.nextCursor).toBeUndefined(); // last page
  });

  it('?status=suspended filters correctly within the bounded/paged path', async () => {
    const journal = new InMemoryJournal();
    await journal.put('wfrun:s1', { runId: 's1', status: 'suspended', updatedAt: 10 });
    await journal.put('wfrun:c1', { runId: 'c1', status: 'completed', updatedAt: 20 });
    await journal.put('wfrun:s2', { runId: 's2', status: 'suspended', updatedAt: 30 });
    const app = createStudioApi({ reader: journal });

    const p = await (await call(app, '/workflows/runs?status=suspended&limit=50')).json();
    expect(p.items.map((r: any) => r.runId).sort()).toEqual(['s1', 's2']);
    expect(p.items.every((r: any) => r.status === 'suspended')).toBe(true);
  });

  it('invalid ?status= still 400s when `limit` is given too', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal });
    const res = await call(app, '/workflows/runs?status=bogus&limit=10');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/invalid status/);
  });

  // getMany present (InMemoryJournal's reference impl, same as every other listKeys-based capability in
  // this file) → ONE batched round-trip for the page, never a per-key get() loop.
  it('getMany present: ONE batched round-trip, no per-key get() loop', async () => {
    const journal = new InMemoryJournal();
    await seedWfRuns(journal, 20);
    const getSpy = vi.spyOn(journal, 'get');
    const getManySpy = vi.spyOn(journal, 'getMany');
    const app = createStudioApi({ reader: journal });

    const p = await (await call(app, '/workflows/runs?limit=3')).json();
    expect(p.items).toHaveLength(3);
    // TWO batched round-trips, still zero per-key gets: one for the registry page, one for the
    // `:input` records package #4 reads the workflow name / workKey out of (see withRecordedName —
    // it exists because a derived runId carries no name in its text). The property this test guards
    // is "no per-key loop", and it survives the second read exactly as it did the first.
    expect(getManySpy).toHaveBeenCalledTimes(2);
    expect(getSpy).not.toHaveBeenCalled();
  });

  // No getMany (a bare custom JournalReader without the optional capability) → sequential get(), but
  // bounded by the early exit at `limit` matches — NOT one get() per key in the whole registry (the
  // exact regression this finding is pinned against).
  it('no getMany: sequential get() is bounded by early exit, not a full-registry scan', async () => {
    const journal = new InMemoryJournal();
    await seedWfRuns(journal, 20);
    const bare = {
      listRuns: journal.listRuns.bind(journal),
      readRun: journal.readRun.bind(journal),
      listKeys: journal.listKeys.bind(journal),
      get: journal.get.bind(journal),
      put: journal.put.bind(journal),
    };
    const getSpy = vi.spyOn(bare, 'get');
    const app = createStudioApi({ reader: bare as any });

    const p = await (await call(app, '/workflows/runs?limit=3')).json();
    expect(p.items).toHaveLength(3);
    expect(p.items.map((r: any) => r.runId)).toEqual(['run-20', 'run-19', 'run-18']);
    // 3 registry reads (early exit, not all 20) + 3 `:input` reads — package #4 fills a missing
    // `workflowName`/`workKey` from the run's own record, because a derived runId has no name in its
    // text for the UI to parse. The PROPERTY this test guards is unchanged and is the reason the
    // number is written as `limit`-shaped rather than as a bare 6: the cost tracks the page, never
    // the registry. These seeded rows all lack a name, so this is the worst case.
    expect(getSpy).toHaveBeenCalledTimes(3 * 2);
  });

  // PACKAGE #4 — the name comes from the RECORD, not from the id's text.
  // studio-ui's `deriveWorkflowName` reads `wf-<name>-<ts>` out of a runId; an engine-derived id
  // (`run1_<hex>`) has no such text, so a suspended derived run used to reach the inbox nameless and
  // the operator had to guess which workflow to resume. `registry.runWorkflow` had written the answer
  // into `<runId>:input` all along (`workflow: <name>`, plus the caller's `workKey`).
  it('a row without workflowName is filled from `<runId>:input`, and a recorded one is never overwritten', async () => {
    const journal = new InMemoryJournal();
    const derived = `run1_${'a'.repeat(32)}#2`;
    await journal.put(`wfrun:${derived}`, { runId: derived, status: 'suspended', updatedAt: 10 });
    await journal.put(`${derived}:input`, { _v: 1, at: 1, workflow: 'order-fulfillment', workKey: 'nightly-reconciliation' });
    // …and a row that already carries a name keeps it, even when the record says something else.
    await journal.put('wfrun:wf-invoice-1', { runId: 'wf-invoice-1', status: 'suspended', updatedAt: 20, workflowName: 'invoice' });
    await journal.put('wf-invoice-1:input', { _v: 1, at: 1, workflow: 'something-else' });
    const app = createStudioApi({ reader: journal });

    const paged = await (await call(app, '/workflows/runs?status=suspended&limit=50')).json();
    const row = paged.items.find((r: any) => r.runId === derived);
    expect(row.workflowName).toBe('order-fulfillment');
    expect(row.workKey).toBe('nightly-reconciliation');
    expect(paged.items.find((r: any) => r.runId === 'wf-invoice-1').workflowName).toBe('invoice');

    // the legacy flat array (no `limit`) gets the same treatment — one route, one answer
    const flat = await (await call(app, '/workflows/runs?status=suspended')).json();
    expect(flat.find((r: any) => r.runId === derived).workflowName).toBe('order-fulfillment');
  });

  it('an unreadable or absent `:input` leaves the row nameless rather than failing the inbox', async () => {
    const journal = new InMemoryJournal();
    await journal.put('wfrun:run-x', { runId: 'run-x', status: 'suspended', updatedAt: 1 });
    const bare = {
      listKeys: journal.listKeys.bind(journal),
      get: async (k: string) => { if (k.endsWith(':input')) throw new Error('boom'); return journal.get(k); },
      put: journal.put.bind(journal),
    };
    const app = createStudioApi({ reader: bare as any });
    const p = await (await call(app, '/workflows/runs?status=suspended&limit=50')).json();
    expect(p.items).toHaveLength(1);
    expect(p.items[0].workflowName).toBeUndefined();
  });
});
