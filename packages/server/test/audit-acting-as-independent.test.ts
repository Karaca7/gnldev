// `actingAs` — the field that separates "acme's own admin did this" from "the operator did this
// inside acme".
//
// `org` answers "which organization was this about", and it fills from the actor's own binding OR from
// the scope the request resolved into. Both give `acme` for a platform operator working inside acme, so
// the record could not tell the two apart — and the second is the event a customer asks about.
//
// THE TRAP THIS FILE IS BUILT AROUND. In the case that motivated the field, `actingAs` and `org` hold
// the SAME value, so a test that only asserts `actingAs === 'acme'` passes on an implementation that
// simply copies `org`. The distinguishing case is the BOUND identity: `org` set, `actingAs` ABSENT.
// Every test here is paired against that case, and `actingAs = org` is mutated to prove it.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, listLog } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

type AuditRecord = { actor?: string; action?: string; target?: string; org?: string; actingAs?: string; reason?: string };

const authProvider = {
  authenticate: (req: Request) => {
    const t = req.headers.get('authorization')?.replace('Bearer ', '');
    if (t === 'acme-adm') return { roles: ['admin'], id: 'u-acme', orgId: 'acme' };
    if (t === 'globex-adm') return { roles: ['admin'], id: 'u-globex', orgId: 'globex' };
    if (t === 'ops') return { roles: ['admin'], id: 'u-ops' }; // unbound platform operator
    return null;
  },
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: false, users: false }),
};
const AS = {
  acme: { authorization: 'Bearer acme-adm' },
  globex: { authorization: 'Bearer globex-adm' },
  ops: { authorization: 'Bearer ops' },
};

async function mkApi() {
  const journal = new InMemoryJournal();
  // A run in each organization, so a cancel has something real to act on.
  for (const [org, run] of [['acme', 'r-acme'], ['globex', 'r-globex']] as const) {
    // `:input` is what `POST /runs/:id/cancel` checks for existence — without it the route answers 404
    // and never reaches the audit line, so the whole file would assert on records that were never written.
    await journal.put(`org:${org}:${run}:input`, { prompt: 'x', at: 1 });
    await journal.put(`org:${org}:${run}:model:0`, { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
    await journal.put(`org:${org}:${run}:outcome`, { status: 'completed', at: 1 });
  }
  // A run in the SHARED (org-less) scope, for the operator-acting-outside-any-organization case.
  await journal.put('r-shared:input', { prompt: 'x', at: 1 });
  const api = createRestApi(
    { journal, agents: {} } as never,
    { org: {}, auth: authProvider } as never,
  );
  return { api, journal };
}

/** Cancels a run and returns the audit record it wrote. */
async function cancelAndAudit(
  api: unknown, journal: InMemoryJournal, runId: string, headers: Record<string, string>,
): Promise<AuditRecord | undefined> {
  const before = (await listLog<AuditRecord>(journal, '__audit__')).length;
  await call(api as never, `/runs/${runId}/cancel`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{}',
  });
  const after = await listLog<AuditRecord>(journal, '__audit__');
  return after.length > before ? (after[after.length - 1] as { payload?: AuditRecord }).payload ?? (after[after.length - 1] as unknown as AuditRecord) : undefined;
}

describe('an unbound operator acting inside an organization', () => {
  it('is recorded as acting as that organization', async () => {
    const { api, journal } = await mkApi();
    const rec = await cancelAndAudit(api, journal, 'r-acme', { ...AS.ops, 'x-gnl-org': 'acme' });

    expect(rec, 'no audit record was written at all').toBeTruthy();
    expect(rec!.org, 'the record does not say which organization this was about').toBe('acme');
    expect(rec!.actingAs,
      'the record cannot distinguish the operator acting inside acme from acme\'s own admin — which is '
      + 'the event a customer would ask about')
      .toBe('acme');
  });

  it('carries the reason the operator gave', async () => {
    const { api, journal } = await mkApi();
    const rec = await cancelAndAudit(api, journal, 'r-acme', {
      ...AS.ops, 'x-gnl-org': 'acme', 'x-gnl-reason': 'destek talebi #4712',
    });

    expect(rec!.reason, 'the operator supplied a reason and the trail did not keep it').toBe('destek talebi #4712');
  });

  it('and records the action without one when none is given', async () => {
    const { api, journal } = await mkApi();
    const rec = await cancelAndAudit(api, journal, 'r-acme', { ...AS.ops, 'x-gnl-org': 'acme' });

    expect(rec!.actingAs, 'the record was dropped entirely for want of a reason').toBe('acme');
    expect('reason' in rec!, 'an absent reason was stored as an empty field rather than omitted').toBe(false);
  });
});

/**
 * THE DISCRIMINATING CASE. A bound identity acting in its OWN organization must have `org` and NOT
 * `actingAs` — acting inside your own organization is not acting as anyone.
 *
 * Without these, `actingAs = org` is indistinguishable from the real implementation: in the operator
 * case above the two hold the same value, so copying `org` would satisfy every assertion there.
 */
describe('a bound identity acting in its own organization', () => {
  it.each([['acme', 'r-acme'], ['globex', 'r-globex']] as const)(
    '%s has an org but no actingAs', async (org, runId) => {
      const { api, journal } = await mkApi();
      const rec = await cancelAndAudit(api, journal, runId, AS[org]);

      expect(rec, 'no audit record was written').toBeTruthy();
      expect(rec!.org, 'the record lost the organization entirely').toBe(org);
      expect(rec!.actingAs,
        'a bound identity was recorded as ACTING AS its own organization. Either `actingAs` is just a '
        + 'second name for `org`, or the "no organization of their own" condition was dropped — and the '
        + 'field then says nothing that `org` did not already say.')
        .toBeUndefined();
      expect('actingAs' in rec!, 'actingAs was stored as an empty field rather than omitted').toBe(false);
    });

  // The two fields must not be interchangeable across the whole matrix, not just in one case.
  it('so actingAs is present in exactly one of the two shapes', async () => {
    const { api, journal } = await mkApi();
    const bound = await cancelAndAudit(api, journal, 'r-acme', AS.acme);
    const unbound = await cancelAndAudit(api, journal, 'r-acme', { ...AS.ops, 'x-gnl-org': 'acme' });

    expect(bound!.org, 'the two cases disagree about `org`, so they are not comparable').toBe(unbound!.org);
    expect([bound!.actingAs, unbound!.actingAs],
      'both shapes carry the same actingAs — the field does not discriminate on the only axis it exists for')
      .toEqual([undefined, 'acme']);
  });
});

describe('an operator acting outside any organization', () => {
  it('has neither field', async () => {
    const { api, journal } = await mkApi();
    // No org header: the request resolves into no organization at all.
    await call(api as never, '/runs/r-shared/cancel', {
      method: 'POST', headers: { 'content-type': 'application/json', ...AS.ops }, body: '{}',
    });
    const log = await listLog<AuditRecord>(journal, '__audit__');
    const rec = (log[log.length - 1] as { payload?: AuditRecord })?.payload;

    expect(rec, 'no audit record was written for an org-less cancel').toBeTruthy();
    expect(rec!.actingAs, 'an operator acting in no organization was recorded as acting as one').toBeUndefined();
    expect(rec!.org, 'an org appeared from nowhere').toBeUndefined();
  });

  it('and the actor is still recorded, so the trail is not anonymous', async () => {
    const { api, journal } = await mkApi();
    const rec = await cancelAndAudit(api, journal, 'r-acme', { ...AS.ops, 'x-gnl-org': 'acme' });
    expect(rec!.actor, 'the record does not say who did it').toBe('u-ops');
    expect(rec!.action).toBe('run.cancel');
    expect(rec!.target).toBe('r-acme');
  });
});
