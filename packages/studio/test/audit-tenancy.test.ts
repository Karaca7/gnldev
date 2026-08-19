// An org-scoped audit view must start at that org's CURRENT tenancy.
//
// `__audit__` lives at the root and is deliberately not org-prefixed, so `purgeOrganization` does not
// touch it — an audit log that can be erased by the operation it is meant to record is not an audit
// log, and the operator's own history has to survive the deletion too.
//
// The consequence, measured: purge removes the org's data and leaves every record tagged
// `org: 'acme'` in place. Org ids are strings a human chooses — a company slug — so the same id going
// to a different tenant later is ordinary rather than exotic. The next tenant of that id then opened
// /audit and read who did what during the previous tenancy: actors, actions, targets.
//
// Fixed with a boundary marker rather than a deletion. `purgeOrganization` records when the id was
// released, and an org-scoped view only shows what happened after. The operator's unscoped view is
// unchanged and still shows everything, including the purge.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, appendLog, countLog, withOrg, purgeOrganization, orgPurgedKey } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

type Row = { actor: string; action: string; org?: string };

const audit = async (app: unknown, headers: Record<string, string> = {}) =>
  ((await (await call(app as never, '/audit', { headers })).json()) as { items: Row[] }).items;

/** Seeds an org with one data key and one audit record naming `actor`. */
async function seedTenant(journal: InMemoryJournal, org: string, actor: string, runId: string) {
  await withOrg(journal, org).put(`${runId}:input`, { prompt: 'x' });
  await appendLog(journal, '__audit__', { actor, action: 'run.cancel', target: runId, org });
}

describe('an org id that is reused after a purge', () => {
  it('does not show the previous tenant\'s audit records to the new one', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });

    await seedTenant(journal, 'acme', 'previous-tenant', 'r1');
    expect(await audit(app, { 'x-gnl-org': 'acme' }), 'the first tenant should see its own record').toHaveLength(1);

    await purgeOrganization(journal, 'acme');
    // The id is handed to somebody else, who then does something of their own.
    await new Promise((r) => setTimeout(r, 5));
    await appendLog(journal, '__audit__', { actor: 'new-tenant', action: 'run.start', target: 'r9', org: 'acme' });

    const seen = await audit(app, { 'x-gnl-org': 'acme' });
    expect(seen.map((i) => i.actor), 'the new tenant read the previous tenancy\'s history').toEqual(['new-tenant']);
  });

  it('still shows the operator everything, including the purged tenancy', async () => {
    // The other half, and the reason the records are not deleted: whoever runs the platform must be
    // able to answer "what happened to that org" after it is gone.
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });

    await seedTenant(journal, 'acme', 'previous-tenant', 'r1');
    await purgeOrganization(journal, 'acme');
    await new Promise((r) => setTimeout(r, 5));
    await appendLog(journal, '__audit__', { actor: 'new-tenant', action: 'run.start', target: 'r9', org: 'acme' });

    const all = await audit(app);
    expect(all.map((i) => i.actor).sort()).toEqual(['new-tenant', 'previous-tenant']);
  });

  it('leaves an org that was never purged completely alone', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });
    await seedTenant(journal, 'globex', 'someone', 'r2');

    expect(await audit(app, { 'x-gnl-org': 'globex' })).toHaveLength(1);
    expect(await journal.get(orgPurgedKey('globex')), 'no marker should exist without a purge').toBeUndefined();
  });

  it('purging one org does not shorten another org\'s history', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });
    await seedTenant(journal, 'acme', 'acme-user', 'r1');
    await seedTenant(journal, 'globex', 'globex-user', 'r2');

    await purgeOrganization(journal, 'acme');

    expect((await audit(app, { 'x-gnl-org': 'globex' })).map((i) => i.actor)).toEqual(['globex-user']);
    expect(await audit(app, { 'x-gnl-org': 'acme' })).toHaveLength(0);
  });

  it('hides rather than leaks when a record lands in the same millisecond as the purge', async () => {
    // The tie has to break one way. Entry timestamps and the marker are both `Date.now()`, and log ids
    // carry a random suffix, so a record written in the purge's own millisecond cannot be attributed to
    // either tenancy. It is hidden: a suppressed record is a gap in one view, a leaked one is the
    // previous tenant's activity handed to their successor. In production the two events are minutes
    // apart; this pins the direction rather than pretending the tie cannot happen.
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, org: {} });

    await appendLog(journal, '__audit__', { actor: 'same-ms', action: 'run.start', target: 'r1', org: 'acme' });
    await journal.put(orgPurgedKey('acme'), { at: Number.MAX_SAFE_INTEGER });

    expect(await audit(app, { 'x-gnl-org': 'acme' }), 'a record at the boundary was shown to the next tenant').toHaveLength(0);
    // ...while the operator still has it — hidden from one view, not erased.
    expect(await audit(app)).toHaveLength(1);
  });
});

// Reading the audit log must not cost one round trip per record in the platform's history.
//
// `listLog` is one `journal.get` per record, which was fine while each writer had its own log. Pinning
// every organization's writes to the single root log changed that: measured, a request for `limit=1`
// scoped to one org performed 2001 gets against a 2000-record log. In process that is milliseconds; on
// Postgres it is 2000 round trips to return one row, and nothing sweeps the log, so it only grows.
describe('the audit endpoint on a large log', () => {
  /** Counts journal reads without changing behaviour. */
  function counting(journal: InMemoryJournal) {
    const counts = { get: 0 };
    const proxy = new Proxy(journal, {
      get(target: any, prop) {
        if (prop === 'get') return async (k: string) => { counts.get++; return target.get(k); };
        const v = target[prop];
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    return { counts, proxy: proxy as unknown as InMemoryJournal };
  }

  it('reads a bounded window instead of the whole history', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 2000; i++) {
      await appendLog(journal, '__audit__', { actor: 'a', action: 'run.start', target: `r${i}`, org: 'acme' });
    }
    const { counts, proxy } = counting(journal);
    const app = createStudioApi({ reader: proxy, org: {} });

    const res = await (await call(app as never, '/audit?limit=1', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(res.items).toHaveLength(1);
    expect(counts.get, `a one-row page read ${counts.get} records`).toBeLessThan(600);
  });

  it('says so when the window cut the history short', async () => {
    // A filter that matches nothing inside the window looks exactly like a filter that matches nothing
    // at all, and only one of those is worth changing the query over.
    const journal = new InMemoryJournal();
    for (let i = 0; i < 2000; i++) {
      await appendLog(journal, '__audit__', { actor: 'a', action: 'run.start', target: `r${i}`, org: 'acme' });
    }
    const app = createStudioApi({ reader: journal, org: {} });
    const res = await (await call(app as never, '/audit?limit=1', { headers: { 'x-gnl-org': 'acme' } })).json();

    expect(res.truncated, 'a partial answer was presented as a complete one').toBe(true);
    expect(res.total).toBe(2000);
    expect(res.scanned).toBeLessThan(2000);
  });

  it('does not claim truncation when the whole log fits', async () => {
    const journal = new InMemoryJournal();
    for (let i = 0; i < 5; i++) {
      await appendLog(journal, '__audit__', { actor: 'a', action: 'run.start', target: `r${i}`, org: 'acme' });
    }
    const app = createStudioApi({ reader: journal, org: {} });
    const res = await (await call(app as never, '/audit', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(res.truncated).toBe(false);
    expect(res.items).toHaveLength(5);
  });

  it('keeps the RECENT end of the log, not an arbitrary slice', async () => {
    // The window is only useful if it is the recent end. Ids are `<base36 millis>-<random>`, so sorting
    // the key list descending is newest-first WITHOUT reading anything — but only to millisecond
    // resolution: records written inside one millisecond share a prefix and are ordered by their random
    // suffix. The first version of this test wrote 1200 records in a tight loop, so hundreds shared a
    // millisecond and the "top 3" came back as 1184, 1149, … — the implementation is not wrong, the
    // assertion was stronger than what it promises. Written with distinct timestamps, which is what an
    // audit log looks like in practice.
    const journal = new InMemoryJournal();
    const base = Date.now() - 2000 * 1000;
    for (let i = 0; i < 2000; i++) {
      await journal.put(`__audit__:${(base + i * 1000).toString(36)}-${String(i).padStart(6, '0')}`, {
        id: `e${i}`, payload: { actor: `actor-${i}`, action: 'run.start', target: `r${i}`, org: 'acme' },
        at: base + i * 1000,
      });
    }
    const app = createStudioApi({ reader: journal, org: {} });
    const res = await (await call(app as never, '/audit?limit=3', { headers: { 'x-gnl-org': 'acme' } })).json();

    expect((res.items as { actor: string }[]).map((i) => i.actor)).toEqual(['actor-1999', 'actor-1998', 'actor-1997']);
  });

});

// Sweeping the audit log is OPT-IN.
//
// Nothing swept `__audit__` anywhere in the codebase, so it grew forever. But how long an audit trail
// is kept is a compliance decision, not a storage one — deleting it on the same schedule as run data
// would be an answer nobody asked for. It happens only when a period is chosen for it.
describe('retention and the audit log', () => {
  async function seedOldAndNew(journal: InMemoryJournal) {
    const old = Date.now() - 90 * 24 * 3600 * 1000;
    for (let i = 0; i < 5; i++) {
      await journal.put(`__audit__:old-${i}`, { id: `old-${i}`, payload: { actor: 'a', action: 'run.start', target: `r${i}` }, at: old });
    }
    for (let i = 0; i < 3; i++) {
      await appendLog(journal, '__audit__', { actor: 'b', action: 'run.start', target: `n${i}` });
    }
  }
  const sweep = (app: unknown, body: unknown) =>
    call(app as never, '/retention/sweep', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });

  it('leaves the log alone unless a period is given', async () => {
    const journal = new InMemoryJournal();
    await seedOldAndNew(journal);
    const app = createStudioApi({ reader: journal });

    const res = await (await sweep(app, { olderThanMs: 1000 })).json();
    expect(res.audit, 'the log was swept without being asked').toBeUndefined();
    expect(await countLog(journal, '__audit__')).toBeGreaterThanOrEqual(8);
  });

  it('sweeps only what is older than the given period', async () => {
    const journal = new InMemoryJournal();
    await seedOldAndNew(journal);
    const app = createStudioApi({ reader: journal });

    const res = await (await sweep(app, { olderThanMs: 1000, auditOlderThanMs: 30 * 24 * 3600 * 1000 })).json();
    expect(res.audit.deleted).toBe(5);
    // The three recent records survive — and so does the record the sweep wrote about itself.
    expect(await countLog(journal, '__audit__')).toBeGreaterThanOrEqual(4);
  });

  it('never erases the evidence of the sweep itself', async () => {
    const journal = new InMemoryJournal();
    await seedOldAndNew(journal);
    const app = createStudioApi({ reader: journal });

    await sweep(app, { olderThanMs: 1000, auditOlderThanMs: 1 });
    const rows = await audit(app);
    expect(rows.map((r) => r.action), 'the sweep swept away its own record').toContain('retention.sweep');
  });
});
