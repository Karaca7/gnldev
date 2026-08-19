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
import { InMemoryJournal, appendLog, withOrg, purgeOrganization, orgPurgedKey } from '@gnldev/durable';
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
