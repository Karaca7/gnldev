// Workflow what-if fork: the first `upto` steps' journal output is copied to a new runId;
// composite sub-keys (foreach[i], loop#k) travel with their owning step; lands in audit.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, claimRunOwner, runOwnerOf, user, STAFF } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

function appWith(journal: InMemoryJournal) {
  return createStudioApi({
    reader: journal,
    gnl: {
      listAgents: () => [],
      run: async () => ({}),
      listWorkflows: () => [{ name: 'order', steps: [{ id: 'validate' }, { id: 'collect' }, { id: 'approve' }] }],
    },
  });
}

describe('workflow what-if fork', () => {
  it('upto=2: the first two steps (+composite sub-keys) are copied, the rest are not', async () => {
    const journal = new InMemoryJournal();
    await journal.put('run-1:wf:validate', { ok: true });
    await journal.put('run-1:wf:collect', { items: 3 });
    await journal.put('run-1:wf:collect[0]', { item: 'a' }); // composite sub-key
    await journal.put('run-1:wf:approve', { approved: true }); // OUTSIDE upto — must NOT be copied
    const app = appWith(journal);

    const res = await call(app, '/workflows/order/runs/run-1/fork', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-actor': 'ops@acme.co' },
      body: JSON.stringify({ upto: 2, newRunId: 'run-1-whatif' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ ok: true, newRunId: 'run-1-whatif', copied: 3, keptSteps: ['validate', 'collect'] });

    expect(await journal.get('run-1-whatif:wf:validate')).toEqual({ ok: true });
    expect(await journal.get('run-1-whatif:wf:collect')).toEqual({ items: 3 });
    expect(await journal.get('run-1-whatif:wf:collect[0]')).toEqual({ item: 'a' });
    expect(await journal.get('run-1-whatif:wf:approve')).toBeUndefined(); // everything after the chosen step will re-run
    // the source run is untouched
    expect(await journal.get('run-1:wf:approve')).toEqual({ approved: true });

    // an audit record landed
    const audit = await (await call(app, '/audit?action=fork')).json();
    expect(audit.items[0]).toMatchObject({ actor: 'ops@acme.co', target: 'run-1', detail: { workflow: 'order', upto: 2 } });
  });

  it('unknown workflow 404; similarly-prefixed step names don\'t get mixed up (a vs ab)', async () => {
    const journal = new InMemoryJournal();
    await journal.put('r:wf:a', 1);
    await journal.put('r:wf:ab', 2); // NOT a sub-key of step 'a' — a separate step
    const app = createStudioApi({
      reader: journal,
      gnl: { listAgents: () => [], run: async () => ({}), listWorkflows: () => [{ name: 'w', steps: [{ id: 'a' }, { id: 'ab' }] }] },
    });

    expect((await call(app, '/workflows/nope/runs/r/fork', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);

    const res = await (await call(app, '/workflows/w/runs/r/fork', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upto: 1, newRunId: 'r2' }),
    })).json();
    expect(res.copied).toBe(1); // only 'a'; 'ab' is outside upto and was NOT mixed up by the prefix
    expect(await journal.get('r2:wf:a')).toBe(1);
    expect(await journal.get('r2:wf:ab')).toBeUndefined();
  });
});

// A fork is a run birth (ADR-0002 point 3): it belongs to its SOURCE's owner, recorded before a row is
// copied — so a crash half-way leaves a fork its owner can finish and nobody else can take.
describe('workflow what-if fork: the owner comes with it', () => {
  const fork = (app: ReturnType<typeof appWith>, src: string, dst: string) => call(app, `/workflows/order/runs/${src}/fork`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ upto: 1, newRunId: dst }),
  });

  it('a fork of Ayşe\'s run is Ayşe\'s; a fork of a staff run is staff\'s', async () => {
    const journal = new InMemoryJournal();
    await claimRunOwner(journal, 'mine', user('u-ayse'), { workflow: 'order' });
    await journal.put('mine:wf:validate', { ok: true });
    await claimRunOwner(journal, 'ops', STAFF, { workflow: 'order' });
    await journal.put('ops:wf:validate', { ok: true });
    const app = appWith(journal);
    expect((await fork(app, 'mine', 'mine-f')).status).toBe(200);
    expect((await fork(app, 'ops', 'ops-f')).status).toBe(200);
    expect(await runOwnerOf(journal, 'mine-f')).toMatchObject({ state: 'owned', owner: { kind: 'user', id: 'u-ayse' }, kind: 'workflow' });
    expect(await runOwnerOf(journal, 'ops-f')).toMatchObject({ state: 'owned', owner: { kind: 'staff' } });
  });

  it('a fork of a run that does not exist is a 404, and leaves nothing behind', async () => {
    const journal = new InMemoryJournal();
    const res = await fork(appWith(journal), 'ghost', 'ghost-f');
    expect(res.status).toBe(404);
    expect(await journal.listKeys('ghost-f')).toEqual([]);
  });
});
