// Studio's price-table surface.
//
// DEFAULT_PRICING is compiled into @gnldev/durable, so it is stale the day it ships and knows nothing
// about a model released last week. An unpriced model counts as $0, and a $0 step cannot exceed any
// maxCostUsd — so the ceiling stops capping without failing. The journal's `__pricing__` document is
// the fix that does not require us to publish a release, and these routes are how an operator edits it.
//
// The assertions that matter are the ones about what must NOT happen: a bound identity changing what
// every other organization is billed at, a NaN price being stored, and a save silently overwriting
// another admin's.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const AUTH = () => roleAuth({
  admin: { token: 'op', user: 'ops' },              // unbound operator
  viewer: { token: 'acme-view', orgId: 'acme' },    // bound, read-only
});

/**
 * An ADMIN bound to an organization — the only persona that reaches the platform-admin gate.
 *
 * The bound identity here used to be the viewer, which has no write permission, so `allowP` refused
 * first and `requirePlatformAdmin` was never consulted. Measured: deleting that gate entirely left all
 * eight tests green. The same mistake as the fail-open this suite exists for — testing the boundary with
 * a persona that cannot reach it.
 */
const BOUND_ADMIN = () => roleAuth({ admin: { token: 'acme-adm', user: 'acme-ops', orgId: 'acme' } });
const H = (t: string) => ({ 'content-type': 'application/json', authorization: `Bearer ${t}` });

const api = (journal = new InMemoryJournal()) => ({
  app: createStudioApi({ reader: journal, auth: AUTH(), org: {} }),
  journal,
});

const put = (app: never, token: string, body: unknown) =>
  call(app, '/pricing', { method: 'PUT', headers: H(token), body: JSON.stringify(body) });

describe('Studio /pricing', () => {
  it('starts from the shipped table with no overrides', async () => {
    const { app } = api();
    const res = await (await call(app as never, '/pricing', { headers: H('op') })).json();
    expect(res.overrides).toEqual({});
    expect(res.version).toBe(0);
    expect(res.effective['gpt-4o'].inputPer1M).toBe(2.5);
  });

  it('an override LAYERS over the shipped table rather than replacing it', async () => {
    // The failure this prevents: an operator adds tomorrow's model, and gpt-4o silently becomes $0 —
    // a ceiling that stops capping as a side effect of fixing a ceiling.
    const { app } = api();
    expect((await put(app as never, 'op', { models: { 'acme/new': { inputPer1M: 10, outputPer1M: 30 } } })).status).toBe(200);

    const res = await (await call(app as never, '/pricing', { headers: H('op') })).json();
    expect(res.overrides['acme/new']).toEqual({ inputPer1M: 10, outputPer1M: 30 });
    expect(res.effective['gpt-4o'].inputPer1M, 'an untouched model lost its price').toBe(2.5);
    expect(res.effective['acme/new'].inputPer1M).toBe(10);
  });

  it('the saved table is what the ceiling actually reads', async () => {
    // Not just "the document was written": the same journal, read back through the durable helper the
    // ceiling uses. A settings screen that saves somewhere nothing consults is the failure mode here.
    const { app, journal } = api();
    await put(app as never, 'op', { models: { 'acme/new': { inputPer1M: 10, outputPer1M: 30 } } });
    const { effectivePricingTable } = await import('@gnldev/durable');
    const table = await effectivePricingTable(journal as never);
    expect(table['acme/new']).toEqual({ inputPer1M: 10, outputPer1M: 30 });
  });

  it('refuses a NaN or negative price', async () => {
    // NaN is the dangerous one: it stores, it produces NaN costs, and `NaN > limit` is false — the
    // ceiling stops capping and nothing errors.
    const { app } = api();
    for (const bad of [Number.NaN, -1, 'free', null]) {
      const res = await put(app as never, 'op', { models: { x: { inputPer1M: bad, outputPer1M: 1 } } });
      expect(res.status, `accepted inputPer1M=${String(bad)}`).toBe(400);
    }
    const cached = await put(app as never, 'op', { models: { x: { inputPer1M: 1, outputPer1M: 1, cachedInputPer1M: -5 } } });
    expect(cached.status).toBe(400);
  });

  it('an org-bound ADMIN cannot change what every organization is billed at', async () => {
    // Bound AND allowed to write: the combination that actually reaches requirePlatformAdmin. A bound
    // viewer is refused one gate earlier and proves nothing about this one.
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal, auth: BOUND_ADMIN(), org: {} });

    const res = await put(app as never, 'acme-adm', { models: { 'gpt-4o': { inputPer1M: 0, outputPer1M: 0 } } });
    expect(res.status, 'a bound admin wrote the table every organization is billed against').toBe(403);
    expect(await res.text()).toMatch(/operator required/);

    // And nothing landed: the refusal is before the write, not after it.
    const { effectivePricingTable } = await import('@gnldev/durable');
    expect((await effectivePricingTable(journal as never))['gpt-4o'].inputPer1M).toBe(2.5);
  });

  it('a bound VIEWER is refused too, one gate earlier — both refusals matter', async () => {
    const { app } = api();
    const res = await put(app as never, 'acme-view', { models: { 'gpt-4o': { inputPer1M: 0, outputPer1M: 0 } } });
    expect([401, 403]).toContain(res.status);
  });

  it('refuses a save that would overwrite another admin\'s, when the client says which version it edited', async () => {
    const { app } = api();
    await put(app as never, 'op', { models: { a: { inputPer1M: 1, outputPer1M: 1 } } }); // → v1

    const stale = await put(app as never, 'op', { ifVersion: 0, models: { b: { inputPer1M: 2, outputPer1M: 2 } } });
    expect(stale.status).toBe(409);
    expect((await stale.json()).code).toBe('version_conflict');

    const fresh = await put(app as never, 'op', { ifVersion: 1, models: { b: { inputPer1M: 2, outputPer1M: 2 } } });
    expect(fresh.status).toBe(200);
    expect((await fresh.json()).version).toBe(2);
  });

  it('replace: true is opt-in and reported back', async () => {
    const { app } = api();
    await put(app as never, 'op', { replace: true, models: { only: { inputPer1M: 1, outputPer1M: 1 } } });
    const res = await (await call(app as never, '/pricing', { headers: H('op') })).json();
    expect(res.replace).toBe(true);
    expect(res.effective['gpt-4o'], 'replace: true must actually drop the shipped table').toBeUndefined();
  });

  it('the change lands in the audit trail', async () => {
    const { app } = api();
    await put(app as never, 'op', { models: { a: { inputPer1M: 1, outputPer1M: 1 } } });
    const audit = await (await call(app as never, '/audit?action=pricing.update', { headers: H('op') })).json();
    expect(audit.items.length).toBeGreaterThan(0);
    expect(audit.items[0].actor).toBe('ops');
    expect(audit.items[0].detail.models).toContain('a');
  });

  it('a bound org admin sees the operator\'s prices, and is told it cannot edit them', async () => {
    // The document only ever exists at the ROOT (PUT requires an unbound operator), so reading it
    // through the org-scoped `rw` showed a bound admin an empty override list AND dropped the
    // operator's corrections from `effective` — the price their runs are actually billed at, reported
    // as the shipped default. Measured: operator sets x/y to 9, the bound admin saw neither.
    const journal = new InMemoryJournal();
    const opApp = createStudioApi({ reader: journal, auth: AUTH(), org: {} });
    await put(opApp as never, 'op', { models: { 'x/y': { inputPer1M: 9, outputPer1M: 9 } } });

    const boundApp = createStudioApi({ reader: journal, auth: BOUND_ADMIN(), org: {} });
    const res = await (await call(boundApp as never, '/pricing', { headers: H('acme-adm') })).json();

    expect(res.overrides['x/y'], 'a bound admin cannot see the operator\'s override').toBeDefined();
    expect(res.effective['x/y'].inputPer1M, 'a bound admin was billed at a price it cannot see').toBe(9);
    // ...and the screen must not offer an editor whose Save answers 403.
    expect(res.editable, 'the UI was told a bound admin can edit global pricing').toBe(false);
  });

  it('an unbound operator is still told it CAN edit', async () => {
    const { app } = api();
    const res = await (await call(app as never, '/pricing', { headers: H('op') })).json();
    expect(res.editable).toBe(true);
  });

  it('refuses replace:true with an empty table — that prices nothing at all', async () => {
    // effectivePricingTable would return `{}`: every model counts as $0 and every ceiling stops firing.
    // The UI reaches it in two clicks (the row bin removes the last override, `replace` rides along).
    const { app, journal } = api();
    const res = await put(app as never, 'op', { replace: true, models: {} });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/stop firing/);

    const { effectivePricingTable } = await import('@gnldev/durable');
    expect(Object.keys(await effectivePricingTable(journal as never)).length, 'the table was emptied anyway')
      .toBeGreaterThan(0);
  });

  it('bounds the document size — it is re-read and spread on every model step', async () => {
    const { app } = api();
    const many = Object.fromEntries(
      Array.from({ length: 501 }, (_, i) => [`m${i}`, { inputPer1M: 1, outputPer1M: 1 }]),
    );
    expect((await put(app as never, 'op', { models: many })).status).toBe(400);

    const longId = { ['x'.repeat(201)]: { inputPer1M: 1, outputPer1M: 1 } };
    expect((await put(app as never, 'op', { models: longId })).status).toBe(400);
  });
});
