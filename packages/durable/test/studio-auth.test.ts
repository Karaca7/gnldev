// Studio admin↔API split: createStudioApi role-based auth (viewer read / admin write) +
// createStudioAdmin apiBase injection. (Test lives in durable: ai/zod are here.)
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { createStudioApi, createStudioAdmin } from '../../studio/src/server.js';
import { roleAuth } from '../../studio/src/auth.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import type { Guard } from '../src/guard.js';
import { call } from './call.js';

function makeModel() {
  return createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('chargeCard', 'call-c', { amount: 5000 }) : finalTextResult('Done.'),
  );
}
const guard: Guard = ({ toolName, args }) =>
  toolName === 'chargeCard' && (args as any).amount > 1000 ? { action: 'require-approval' } : { action: 'allow' };

describe('studio admin↔API split', () => {
  it('createStudioApi: viewer read / admin write (role auth)', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const tools = () => ({ chargeCard: { execute: async () => ({ charged: (counter.charges++, 5000) }) } });
    await runDurable({ runId: 'o1', journal, model: makeModel(), tools: tools(), guard, prompt: 'charge', stopWhen: stepCountIs(6) });

    const api = createStudioApi({
      reader: journal,
      resume: async (runId, approvals) => {
        const r = await resumeRun(runId, { journal, model: makeModel(), tools: tools(), guard, approvals });
        return { text: r.text, interrupts: r.interrupts };
      },
      auth: {
        read: (c) => ['viewer', 'admin'].includes(c.req.header('x-role') ?? ''),
        write: (c) => c.req.header('x-role') === 'admin',
      },
    });

    expect((await call(api, '/runs')).status).toBe(401); // no header → rejected
    expect((await call(api, '/runs', { headers: { 'x-role': 'viewer' } })).status).toBe(200); // viewer reads

    const asAdmin = (body: any) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'admin' }, body: JSON.stringify(body) });
    const asViewer = (body: any) => ({ method: 'POST', headers: { 'content-type': 'application/json', 'x-role': 'viewer' }, body: JSON.stringify(body) });

    expect((await call(api, '/runs/o1/resume', asViewer({ approvals: { 'call-c': true } }))).status).toBe(403); // viewer CANNOT write
    expect(counter.charges).toBe(0);

    const ok = await call(api, '/runs/o1/resume', asAdmin({ approvals: { 'call-c': true } }));
    expect(ok.status).toBe(200); // admin can write
    expect(counter.charges).toBe(1); // exactly-once preserved
  });

  it('AuthProvider (roleAuth): read gate + /capabilities public + authRequired', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'o1', journal, model: makeModel(), tools: { chargeCard: { execute: async () => ({ ok: true }) } }, guard, prompt: 'charge', stopWhen: stepCountIs(6) });
    const api = createStudioApi({ reader: journal, auth: roleAuth({ admin: { token: 'adm' }, viewer: { token: 'viw' } }) });

    expect((await call(api, '/runs')).status).toBe(401); // no header
    expect((await call(api, '/runs', { headers: { 'x-role': 'viewer' } })).status).toBe(401); // wrong scheme
    expect((await call(api, '/runs', { headers: { authorization: 'Bearer viw' } })).status).toBe(200); // viewer reads

    // /capabilities is now PUBLIC (so the UI can see the auth mode before login) + authRequired flag.
    const capsRes = await call(api, '/capabilities');
    expect(capsRes.status).toBe(200);
    expect((await capsRes.json()).authRequired).toBe(true);
  });

  it('createStudioAdmin: apiBase + swagger', async () => {
    const admin = createStudioAdmin({ apiBase: '/studio' });
    // '/' returns the SPA (if dist exists) or a "build required" fallback — both are 200.
    expect((await call(admin, '/')).status).toBe(200);
    // apiBase injection deterministically shows up in openapi.json servers (dist-independent).
    const spec = (await (await call(admin, '/openapi.json')).json()) as any;
    expect(spec.servers[0].url).toBe('/studio/api');
    const sw = await call(admin, '/swagger');
    expect(sw.status).toBe(200);
    expect(await sw.text()).toContain('swagger-ui-bundle');
  });
});
