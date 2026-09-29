// Two processes start the same run id at once. The loser reads `:input` before the winner has written
// it, and then — a moment later — sees the winner's rows. Read in that order, "no record, rows present"
// is the shape of a run from before owners were recorded, and the loser was told the run was staff's:
// RunOwnerMismatchError instead of RunBusyError. Measured on the public release CI and locally
// (2 races in 21 with two real OS processes on one SQLite journal): detail `owner: (staff)`,
// `requested: (unknown)`. The record is always written before a row, so once rows exist, a second
// read of the record finds the owner.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runOwnerOf, claimRunOwner, user, UNKNOWN, type Caller } from '../src/run-identity.js';

/** A journal where the winner's birth lands right after the loser's first read of `:input`. */
function racing(runId: string, winner: Caller) {
  const j = new InMemoryJournal();
  let first = true;
  const racy = new Proxy(j, {
    get(target, prop) {
      if (prop === 'get') {
        return async (key: string) => {
          const v = await target.get(key);
          if (first && key === runKeys.input(runId)) {
            first = false;
            // the winner is born between the loser's two reads: owner record first, then a row
            await claimRunOwner(target as never, runId, winner, { agent: 'a' });
            await target.put(`${runId}:model:0`, { _v: 2, content: [] });
          }
          return v;
        };
      }
      const f = (target as never)[prop];
      return typeof f === 'function' ? (f as Function).bind(target) : f;
    },
  });
  return racy;
}

describe('runOwnerOf during a birth race: rows that appear after a missing record are a new run, not a legacy one', () => {
  it('an unknown-born run read mid-birth is unknown\'s, not staff\'s', async () => {
    const o = await runOwnerOf(racing('race-1', UNKNOWN) as never, 'race-1');
    expect(o).toMatchObject({ state: 'owned', owner: { kind: 'unknown' } });
  });

  it('a user-born run read mid-birth is that user\'s', async () => {
    const o = await runOwnerOf(racing('race-2', user('ayse', 'acme')) as never, 'race-2');
    expect(o).toMatchObject({ state: 'owned', owner: { kind: 'user', id: 'ayse' } });
  });

  it('a real legacy run (rows, never a record) is still read as staff\'s', async () => {
    const j = new InMemoryJournal();
    await j.put('legacy-1:model:0', { _v: 2, content: [] });
    expect(await runOwnerOf(j as never, 'legacy-1')).toMatchObject({ state: 'owned', owner: { kind: 'staff' }, recorded: false });
  });
});
