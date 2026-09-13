// `gnl runs --work-key <k>` — the operator's half of package #5.
//
// WHY THE FLAG EXISTS AT ALL. Once an id is `run1_<32 hex>`, the listing stops answering the
// question people actually ask it. "Which run was the invoice job?" used to be answerable by looking
// at the id, because the id WAS the caller's string. It is not any more, on purpose (§2's four bug
// classes all start there) — so the declared name has to be a column and a filter, or the readable
// half of the system is simply gone.
//
// EXACT MATCH, never a prefix: `invoice-4` must not answer for `invoice-4471`, or an operator's
// "show me this job" quietly becomes "show me this family". That is `listRunsPaged`'s stated
// contract for the same filter, and this filter is the same question asked from a terminal.
import { describe, it, expect } from 'vitest';
import * as Durable from '@gnldev/durable';
import { InMemoryJournal, createGnl } from '@gnldev/durable';
import { listRunsCore } from '../src/commands/runs.js';
import { mkModel, finalText } from './helpers.js';

/** Two named jobs for one person, plus one run that declared nothing. */
async function seed(journal: InMemoryJournal) {
  const gnl = createGnl({ journal, agents: { pay: { model: mkModel(async () => finalText('ok')) } } });
  await gnl.run('pay', { workKey: 'invoice-4471', resourceId: 'u-ayse', prompt: 'a' });
  await gnl.run('pay', { workKey: 'invoice-4', resourceId: 'u-ayse', prompt: 'b' });
  await gnl.run('pay', { runId: 'plain-run', prompt: 'c' });
}

describe('gnl runs --work-key', () => {
  it('shows the declared name as a column, and only where one was declared', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const rows = await listRunsCore({ journal } as any, Durable);
    expect(rows.find((r) => r.runId === 'plain-run')!.workKey).toBeUndefined();
    expect(rows.filter((r) => r.workKey).map((r) => r.workKey).sort()).toEqual(['invoice-4', 'invoice-4471']);
  });

  it('filters to exactly that job — never the family that shares its prefix', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const rows = await listRunsCore({ journal } as any, Durable, { workKey: 'invoice-4' });
    expect(rows.map((r) => r.workKey)).toEqual(['invoice-4']);
  });

  it('a name nobody declared lists nothing, rather than everything', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    expect(await listRunsCore({ journal } as any, Durable, { workKey: 'no-such-job' })).toEqual([]);
  });

  it('the filter runs BEFORE the limit — a page is a page of matches', async () => {
    const journal = new InMemoryJournal();
    await seed(journal);
    const rows = await listRunsCore({ journal } as any, Durable, { workKey: 'invoice-4471', limit: 5 });
    expect(rows.map((r) => r.workKey)).toEqual(['invoice-4471']);
  });
});
