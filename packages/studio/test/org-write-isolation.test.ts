// Does an org-bound identity's org boundary hold on the WRITE surface, not just on reads?
//
// Studio scopes by organization through an AsyncLocalStorage: `scopedNow()` (server.ts) returns
// `withOrg(rawReader, org)` when the ALS holds an org, and the RAW root journal when it does not. The
// middleware only puts an org into the ALS for GET:
//
//   const org = c.req.method === 'GET' ? (bound ?? requested) : requested;   // server.ts
//   if (!org) return next();                                                 // no ALS
//
// So on a POST with no explicit org header, `requested` is undefined, the ALS is never set, and every
// `rw.get`/`rw.put` inside the handler addresses the ROOT journal. Since withOrg's physical prefix is
// `org:<orgId>:` (organization.ts), another organization's run is directly addressable by passing its
// physical key as the run id.
//
// auth-org.test.ts covers the read surface, and it covers it with a VIEWER — an identity with no write
// permission, which can never reach these endpoints. The persona that can is an org-bound ADMIN: a
// tenant's own administrator in a multi-org deployment, which is exactly who the multi-org feature is
// sold to. That combination (bound + run:write) had no test.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

/** An administrator bound to 'acme'. Bound, and allowed to write — the combination that was untested. */
const AUTH = () => roleAuth({ admin: { token: 'acme-adm', user: 'acme-ops', orgId: 'acme' } });

/** A victim run belonging to 'globex', written at its physical (prefixed) keys. */
async function seedVictim(journal: InMemoryJournal) {
  await journal.put('org:globex:victim:input', { prompt: 'globex confidential prompt' });
  await journal.put('org:globex:victim:model:0', { content: [{ type: 'text', text: 'globex secret output' }], finishReason: 'stop' });
}

const asAcme = { authorization: 'Bearer acme-adm', 'content-type': 'application/json' };

describe('@gnldev/studio — the org boundary on the write surface', () => {
  it('an org-bound admin cannot cancel another organization\'s run by naming its physical key', async () => {
    const journal = new InMemoryJournal();
    await seedVictim(journal);
    const app = createStudioApi({ reader: journal, auth: AUTH(), org: {} });

    const res = await call(app, '/runs/org%3Aglobex%3Avictim/cancel', {
      method: 'POST',
      headers: asAcme,
      body: '{}',
    });

    // Either answer is acceptable — 403 (refused) or 404 (invisible, no existence leak, which is what
    // the endpoint's own comment claims it returns for another organization's run). 200 is not.
    expect([403, 404]).toContain(res.status);

    // And the decisive part: the victim must not carry a cancellation flag. A run cancelled this way is
    // TERMINAL — every future resume is refused — so this is destructive, not just a read.
    const flag = await journal.get('org:globex:victim:__gnl_canceled');
    expect(flag, 'globex\'s run was cancelled by an acme-bound identity').toBeUndefined();
  });

  it('an org-bound admin cannot fork another organization\'s run into its own namespace', async () => {
    const journal = new InMemoryJournal();
    await seedVictim(journal);
    // `resume` must be supplied or the endpoint short-circuits with 501 before reaching the fork — the
    // first version of this test omitted it and passed on that 501, proving nothing.
    const app = createStudioApi({ reader: journal, auth: AUTH(), org: {}, resume: async () => ({}) });

    const res = await call(app, '/runs/org%3Aglobex%3Avictim/fork', {
      method: 'POST',
      headers: asAcme,
      body: JSON.stringify({ step: 0, newRunId: 'stolen' }),
    });
    expect(res.status, 'fork must not be reachable across organizations').not.toBe(200);
    expect([403, 404]).toContain(res.status);

    // The exfiltration this would achieve: globex's prompt and model output copied under a key acme can
    // then read back through the legitimate, org-scoped GET surface.
    const stolenRoot = await journal.get('stolen:input');
    const stolenAcme = await journal.get('org:acme:stolen:input');
    expect(stolenRoot ?? stolenAcme, 'globex\'s prompt was copied to a key acme controls').toBeUndefined();
  });
});
