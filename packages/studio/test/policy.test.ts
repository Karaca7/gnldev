// Policy CRUD: rules are versioned, the full rule set lands in audit, validation is strict.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, POLICY_KEY } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

const put = (app: any, body: unknown, actor = 'sec@acme.co') =>
  call(app, '/policy', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-gnl-actor': actor }, body: JSON.stringify(body) });

describe('policy editor API', () => {
  it('save → version increments + written to the journal + the FULL rule set is in audit; GET reads it back', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal });

    expect((await (await call(app, '/policy')).json()).policy).toBeNull();

    const rules = [{ tool: 'chargeCard', action: 'require-approval', reason: 'money' }, { tool: '*', action: 'allow' }];
    expect(await (await put(app, { rules })).json()).toMatchObject({ ok: true, version: 1 });
    expect(await (await put(app, { rules: rules.slice(0, 1) })).json()).toMatchObject({ ok: true, version: 2 });

    const got = await (await call(app, '/policy')).json();
    expect(got.policy.version).toBe(2);
    expect(got.policy.rules).toHaveLength(1);
    // the key policyGuard will read is genuinely populated
    expect(await journal.get(POLICY_KEY)).toMatchObject({ version: 2 });

    const audit = await (await call(app, '/audit?action=policy.update')).json();
    expect(audit.items).toHaveLength(2);
    expect(audit.items[1].detail.rules).toEqual(rules); // v1's full set — read back from historical audit
    expect(audit.items[0].actor).toBe('sec@acme.co');
  });

  it('validation: a rules array is required, an invalid action → 400; capabilities.policy', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    expect((await put(app, {})).status).toBe(400);
    expect((await put(app, { rules: [{ tool: 'x', action: 'boom' }] })).status).toBe(400);
    expect((await put(app, { rules: [{ tool: '', action: 'allow' }] })).status).toBe(400);
    expect((await (await call(app, '/capabilities')).json()).policy).toBe(true);
  });

  // API-08: PUT carried no version → two admins editing concurrently could silently overwrite each
  // other's rules (the version kept incrementing either way, so nothing looked wrong). `ifVersion`
  // turns a stale write into a 409 instead of a lost update.
  it('optimistic lock: ifVersion matching → saves; stale ifVersion → 409 + rules untouched; omitted → old last-write-wins behavior', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal });

    // First save with the correct ifVersion (0, since there's no doc yet) → succeeds.
    const rulesA = [{ tool: 'chargeCard', action: 'deny', reason: 'guard' }];
    expect(await (await put(app, { rules: rulesA, ifVersion: 0 })).json()).toMatchObject({ ok: true, version: 1 });

    // A second admin edits based on the SAME stale version (still thinks it's v0/v1... here v1 is current,
    // but the caller believes v0 like before A's save) → 409, current rules are NOT clobbered.
    const rulesB = [{ tool: 'chargeCard', action: 'allow' }];
    const conflict = await put(app, { rules: rulesB, ifVersion: 0 });
    expect(conflict.status).toBe(409);
    const conflictBody = await conflict.json();
    expect(conflictBody.code).toBe('version_conflict');
    expect(conflictBody.error).toMatch(/expected v0, current v1/);
    expect(conflictBody.current).toMatchObject({ version: 1 });

    // The journal still has A's rules — B's write never landed.
    const afterConflict = await (await call(app, '/policy')).json();
    expect(afterConflict.policy.version).toBe(1);
    expect(afterConflict.policy.rules).toEqual(rulesA);

    // Retrying with the CURRENT version succeeds and bumps the version.
    expect(await (await put(app, { rules: rulesB, ifVersion: 1 })).json()).toMatchObject({ ok: true, version: 2 });
    const afterRetry = await (await call(app, '/policy')).json();
    expect(afterRetry.policy.rules).toEqual(rulesB);

    // Omitting ifVersion entirely → unchanged (backward-compatible) last-write-wins behavior.
    const rulesC = [{ tool: '*', action: 'require-approval' }];
    expect(await (await put(app, { rules: rulesC })).json()).toMatchObject({ ok: true, version: 3 });
  });
});
