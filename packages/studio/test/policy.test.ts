// Policy CRUD: rules are versioned, the full rule set lands in audit, validation is strict.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, POLICY_KEY } from '@gnl/durable';
import { createStudioApi } from '../src/server.js';

const put = (app: any, body: unknown, actor = 'sec@acme.co') =>
  app.request('/policy', { method: 'PUT', headers: { 'content-type': 'application/json', 'x-gnl-actor': actor }, body: JSON.stringify(body) });

describe('policy editor API', () => {
  it('save → version increments + written to the journal + the FULL rule set is in audit; GET reads it back', async () => {
    const journal = new InMemoryJournal();
    const app = createStudioApi({ reader: journal });

    expect((await (await app.request('/policy')).json()).policy).toBeNull();

    const rules = [{ tool: 'chargeCard', action: 'require-approval', reason: 'money' }, { tool: '*', action: 'allow' }];
    expect(await (await put(app, { rules })).json()).toMatchObject({ ok: true, version: 1 });
    expect(await (await put(app, { rules: rules.slice(0, 1) })).json()).toMatchObject({ ok: true, version: 2 });

    const got = await (await app.request('/policy')).json();
    expect(got.policy.version).toBe(2);
    expect(got.policy.rules).toHaveLength(1);
    // the key policyGuard will read is genuinely populated
    expect(await journal.get(POLICY_KEY)).toMatchObject({ version: 2 });

    const audit = await (await app.request('/audit?action=policy.update')).json();
    expect(audit.items).toHaveLength(2);
    expect(audit.items[1].detail.rules).toEqual(rules); // v1's full set — read back from historical audit
    expect(audit.items[0].actor).toBe('sec@acme.co');
  });

  it('validation: a rules array is required, an invalid action → 400; capabilities.policy', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    expect((await put(app, {})).status).toBe(400);
    expect((await put(app, { rules: [{ tool: 'x', action: 'boom' }] })).status).toBe(400);
    expect((await put(app, { rules: [{ tool: '', action: 'allow' }] })).status).toBe(400);
    expect((await (await app.request('/capabilities')).json()).policy).toBe(true);
  });
});
