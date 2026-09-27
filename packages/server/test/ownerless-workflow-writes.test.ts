// A workflow run nobody owns is staff's work: an end user can neither approve it, nor cancel it, nor
// read its steps through the approval, nor become its owner by trying. The hole was that such a run
// left no `<runId>:input`, and the write gates read "no record" as "not started yet — go ahead".
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createGnl, scopeConfigToOrg } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';
import { scheduleWorkflow, pollScheduler } from '../../scheduler/src/index.js';
import { call } from './call.js';

const PRINCIPALS: Record<string, any> = {
  ayse: { kind: 'subject', id: 'ayse', orgId: 'acme', roles: ['admin'] },
  staff: { kind: 'operator', id: 'ops', orgId: 'acme', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
  capabilities: () => ({ sso: false, rbac: false, audit: false, multiOrganization: true, users: false }),
};
const post = (api: never, path: string, who: string, body: unknown) =>
  call(api, path, { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const mkWf = (secret: string) => workflow<unknown>().then(step('draft', async () => secret)).then(waitForResume<{ ok: boolean }>('approve'));
const refused = (s: number) => s === 403 || s === 404;

async function staffStarted(runId: string) {
  const journal = new InMemoryJournal();
  const api = createRestApi({ journal, workflows: { report: mkWf('STAFF-SECRET') } } as any, { auth } as never) as never;
  expect((await post(api, '/workflows/report/run', 'staff', { runId, input: {} })).status).toBe(200);
  return { journal, api };
}

describe('an ownerless workflow run, as seen by an end user', () => {
  it('cannot be approved, leaks no step, and is not claimed by trying', async () => {
    const { journal, api } = await staffStarted('nightly-1');
    const res = await post(api, '/workflows/report/run', 'ayse', { runId: 'nightly-1', resume: { approve: { ok: true } } });
    expect(refused(res.status), `status ${res.status}`).toBe(true);
    expect(await res.text()).not.toContain('STAFF-SECRET');
    expect((await journal.get<any>('org:acme:wfrun:nightly-1'))?.status).toBe('suspended');
    expect((await journal.get<any>('org:acme:nightly-1:input'))?.resourceId).toBeUndefined();
  });

  it('cannot be cancelled', async () => {
    const { journal, api } = await staffStarted('nightly-2');
    const res = await post(api, '/workflows/runs/nightly-2/cancel', 'ayse', {});
    expect(refused(res.status), `status ${res.status}`).toBe(true);
    expect((await journal.get<any>('org:acme:wfrun:nightly-2'))?.status).toBe('suspended');
  });

  it('a system trigger\'s run is the same: staff\'s', async () => {
    const journal = new InMemoryJournal();
    const config = { journal, workflows: { report: mkWf('SYS-SECRET') } } as any;
    await scheduleWorkflow(journal as never, { id: 'rep', name: 'report', input: {}, at: 0, orgId: 'acme' }, 0);
    await pollScheduler(journal as never, createGnl(config), 1, { runnerForOrg: (o) => createGnl(scopeConfigToOrg(config, o).config) });
    const api = createRestApi(config, { auth } as never) as never;
    const res = await post(api, '/workflows/report/run', 'ayse', { runId: 'sched:rep:0', resume: { approve: { ok: true } } });
    expect(refused(res.status), `status ${res.status}`).toBe(true);
    expect((await journal.get<any>('org:acme:wfrun:sched:rep:0'))?.status).toBe('suspended');
  });

  it('a run written before owner records existed (no :input, but a trace) is ownerless, not new', async () => {
    const { journal, api } = await staffStarted('legacy-1');
    await journal.delete?.('org:acme:legacy-1:input');
    await (journal as any).deletePrefix?.('org:acme:legacy-1:input');
    expect(await journal.get('org:acme:legacy-1:input')).toBeUndefined();
    const approve = await post(api, '/workflows/report/run', 'ayse', { runId: 'legacy-1', resume: { approve: { ok: true } } });
    expect(refused(approve.status), `approve ${approve.status}`).toBe(true);
    const cancel = await post(api, '/workflows/runs/legacy-1/cancel', 'ayse', {});
    expect(refused(cancel.status), `cancel ${cancel.status}`).toBe(true);
    expect((await journal.get<any>('org:acme:wfrun:legacy-1'))?.status).toBe('suspended');
  });

  it('staff still approve their own; an owner still approves theirs', async () => {
    const { api } = await staffStarted('nightly-3');
    expect((await post(api, '/workflows/report/run', 'staff', { runId: 'nightly-3', resume: { approve: { ok: true } } })).status).toBe(200);
    expect((await post(api, '/workflows/report/run', 'ayse', { runId: 'mine-1', input: {} })).status).toBe(200);
    expect((await post(api, '/workflows/report/run', 'ayse', { runId: 'mine-1', resume: { approve: { ok: true } } })).status).toBe(200);
  });
});
