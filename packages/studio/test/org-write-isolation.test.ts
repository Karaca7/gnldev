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

/** A victim run belonging to 'globex', addressed by its PHYSICAL (prefixed) key. */
const VICTIM = 'org:globex:victim';
const VICTIM_URL = encodeURIComponent(VICTIM);

async function seedVictim(journal: InMemoryJournal) {
  await journal.put(`${VICTIM}:input`, { prompt: 'globex confidential prompt' });
  await journal.put(`${VICTIM}:model:0`, { content: [{ type: 'text', text: 'globex secret output' }], finishReason: 'stop' });
}

const asAcme = { authorization: 'Bearer acme-adm', 'content-type': 'application/json' };

/**
 * Every per-run endpoint that hands the id to a HOST CALLBACK, with a spy on that callback.
 *
 * The status alone is not the assertion. These endpoints delegate to a function the host wired to its
 * own root journal, so "did the callback see the raw physical key" is the question that decides whether
 * the side effect happened — a 500 with the callback already invoked would still have resumed the run.
 */
function spyApp(journal: InMemoryJournal) {
  const saw: Record<string, unknown[]> = { resume: [], compensate: [], otelExport: [], score: [] };
  const app = createStudioApi({
    reader: journal,
    auth: AUTH(),
    org: {},
    resume: async (id: string) => { saw.resume.push(id); return { ok: true }; },
    compensate: async (id: string, o: unknown) => { saw.compensate.push([id, o]); return { entries: [{ status: 'compensated' }] }; },
    otelExport: async (id: string) => { saw.otelExport.push(id); return { spans: 7 }; },
    scorers: { score: async (id: string) => { saw.score.push(id); return { scores: [{ name: 'j', score: 1, reason: 'globex confidential prompt looked fine' }] }; } },
  } as never);
  return { app, saw };
}

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
    //
    // The key is `runKeys.proc(runId, '__gnl_canceled')` → `<runId>:proc:__gnl_canceled`. The first
    // version of this line omitted the `:proc:` segment, so it read a key that cannot exist and the
    // assertion returned undefined whatever the server did — the part labelled "decisive" was the one
    // part measuring nothing. Asserted through the real writer below rather than a hand-typed string.
    const flag = await journal.get(`${VICTIM}:proc:__gnl_canceled`);
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

  // The three endpoints the first pass missed. cancel and fork got a visibility check written inline;
  // resume, compensate and otel-export did not, and nothing noticed because the check was a line copied
  // per endpoint rather than a rule applied to all of them. Measured on the shipped build before this
  // fix: cancel 404, and these three 200 — with the host callback holding `org:globex:victim`.
  const DELEGATING: Array<[name: string, path: string, body: string, spy: string]> = [
    ['resume', 'resume', '{"approvals":{"c1":true}}', 'resume'],
    ['compensate', 'compensate', '{}', 'compensate'],
    ['compensate (dryRun)', 'compensate', '{"dryRun":true}', 'compensate'],
    ['otel-export', 'otel-export', '{}', 'otelExport'],
  ];

  for (const [name, route, body, spy] of DELEGATING) {
    it(`an org-bound admin cannot ${name} another organization's run`, async () => {
      const journal = new InMemoryJournal();
      await seedVictim(journal);
      const { app, saw } = spyApp(journal);

      const res = await call(app as never, `/runs/${VICTIM_URL}/${route}`, { method: 'POST', headers: asAcme, body });
      expect(res.status, `${name} is reachable across organizations`).not.toBe(200);
      expect([403, 404]).toContain(res.status);
      // The decisive one: the host never saw the id, so the side effect cannot have happened.
      expect(saw[spy], `the host callback was invoked with another organization's run id`).toEqual([]);
    });
  }

  it('an org-bound admin cannot score another organization\'s run', async () => {
    // Read-gated, and still a leak: a scorer's `reason` quotes the run it judged, so the victim's prompt
    // comes back through the explanation field.
    const journal = new InMemoryJournal();
    await seedVictim(journal);
    const { app, saw } = spyApp(journal);

    const res = await call(app as never, `/runs/${VICTIM_URL}/score`, { method: 'POST', headers: asAcme, body: '{}' });
    expect(res.status).not.toBe(200);
    expect(saw.score).toEqual([]);
    expect(await res.text()).not.toContain('globex confidential');
  });

  it('the same endpoints still work on the caller\'s OWN run — this is a boundary, not a lockout', async () => {
    // The direction that would make the fix worse than the hole: refusing everything also "passes" the
    // tests above. Each endpoint must still reach the host for a run the caller can legitimately see.
    const journal = new InMemoryJournal();
    await journal.put('org:acme:mine:input', { prompt: 'acme own run' });
    const { app, saw } = spyApp(journal);

    for (const [, route, body, spy] of DELEGATING) {
      const res = await call(app as never, `/runs/${encodeURIComponent('mine')}/${route}`, { method: 'POST', headers: asAcme, body });
      expect(res.status, `${route} refused the caller's own run`).toBe(200);
      expect((saw[spy] as unknown[]).length, `${route} did not reach the host for an own run`).toBeGreaterThan(0);
    }
  });

  it('tells the host WHICH organization the caller is in, so its own run is reachable', async () => {
    // Studio's read surface strips the org prefix: GET /runs lists `r1`, not `org:acme:r1`. The host's
    // callback holds the ROOT journal, so handing it the bare `r1` sent it looking for a key that only
    // exists as `org:acme:r1:input` — measured: GET /runs → [{runId:'r1'}], POST /runs/r1/resume → 500
    // "no recorded input for runId r1". The Approve button was broken for exactly the multi-org admin.
    //
    // Passing the physical id would have leaked the prefix into single-org hosts and made the id depend
    // on who called. The org travels beside it instead, and a host that ignores it is unaffected.
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r1:input', { prompt: 'acme own work' });

    const seen: Array<{ runId: string; orgId?: string }> = [];
    const app = createStudioApi({
      reader: journal,
      auth: AUTH(),
      org: {},
      resume: async (runId: string, _a: unknown, ctx?: { orgId?: string }) => {
        seen.push({ runId, orgId: ctx?.orgId });
        return { text: 'resumed' };
      },
    } as never);

    const res = await call(app as never, '/runs/r1/resume', { method: 'POST', headers: asAcme, body: '{}' });
    expect(res.status, 'a bound admin cannot resume its own run').toBe(200);
    expect(seen).toEqual([{ runId: 'r1', orgId: 'acme' }]);
  });

  it('an UNBOUND operator gets no orgId — the parameter does not invent a scope', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r1:input', { prompt: 'root run' });

    const seen: Array<{ orgId?: string }> = [];
    const app = createStudioApi({
      reader: journal,
      auth: roleAuth({ admin: { token: 'op', user: 'ops' } }),
      org: {},
      resume: async (_r: string, _a: unknown, ctx?: { orgId?: string }) => { seen.push({ orgId: ctx?.orgId }); return {}; },
    } as never);

    const res = await call(app as never, '/runs/r1/resume', {
      method: 'POST', headers: { authorization: 'Bearer op', 'content-type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ orgId: undefined }]);
  });

  it('every host adapter that can reach another organization is told who asked', async () => {
    // Studio's org boundary is a journal key prefix, and these three endpoints do not touch the
    // journal — they hand the request to an adapter the host owns. Measured from an acme-bound admin
    // before this: `cache/invalidate` with no key returned `{deleted:{removed:9}}` (every
    // organization's cache, in one call), `jobs/:id/retry` requeued another org's dead-letter job, and
    // `knowledge/search` returned `[{"text":"globex private doc"}]` from the whole corpus.
    //
    // Studio cannot filter a host's cache or vector index for it. What it can stop doing is hiding who
    // the caller was — the third parameter is what makes scoping possible on the host's side, and a
    // host that ignores it behaves exactly as before.
    const seen: Record<string, unknown[]> = { cache: [], retry: [], search: [] };
    const app = createStudioApi({
      reader: new InMemoryJournal(),
      auth: AUTH(),
      org: {},
      cache: {
        stats: () => ({ hits: 0, misses: 0, hitRate: 0, size: 0 }),
        invalidate: (key: unknown, ctx?: { orgId?: string }) => { seen.cache.push(ctx?.orgId); return 1; },
      },
      queue: { retry: (_id: string, ctx?: { orgId?: string }) => { seen.retry.push(ctx?.orgId); return 'new-1'; } },
      vectors: { search: (_q: string, _k?: number, ctx?: { orgId?: string }) => { seen.search.push(ctx?.orgId); return []; } },
    } as never);

    await call(app as never, '/cache/invalidate', { method: 'POST', headers: asAcme, body: '{}' });
    await call(app as never, '/jobs/j1/retry', { method: 'POST', headers: asAcme, body: '{}' });
    await call(app as never, '/knowledge/search', { method: 'POST', headers: asAcme, body: '{"query":"x"}' });

    expect(seen.cache, 'cache.invalidate was not told which organization asked').toEqual(['acme']);
    expect(seen.retry, 'queue.retry was not told which organization asked').toEqual(['acme']);
    expect(seen.search, 'vectors.search was not told which organization asked').toEqual(['acme']);
  });
});
