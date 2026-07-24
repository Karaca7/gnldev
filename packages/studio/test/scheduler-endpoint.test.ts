// GET /scheduler/triggers: @gnl/scheduler trigger introspection. Studio itself does NOT require a
// running Scheduler INSTANCE — if the journal supports writable + listKeys, it READS from the
// journal via @gnl/scheduler's `listTriggers` helper (see src/server.ts). Here we write triggers
// to the journal with the real `scheduleWorkflow`/`pollScheduler` and verify they're read back
// end-to-end (instead of a mock like the cache/queue tests — @gnl/scheduler is already a devDependency).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnl/durable';
import { scheduleWorkflow, pollScheduler } from '@gnl/scheduler';
import { createStudioApi } from '../src/server.js';

describe('GET /scheduler/triggers', () => {
  it('reads triggers written to the journal (id, kind/value, nextRunAt, misfire, maxAttempts)', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'daily', name: 'wf-report', cron: '0 9 * * *', maxAttempts: 3 }, Date.UTC(2026, 0, 1, 0, 0));
    await scheduleWorkflow(j, { id: 'poll', name: 'wf-sync', every: 60_000, misfire: 'catchup' }, 0);

    const app = createStudioApi({ reader: j });
    const res = await app.request('/scheduler/triggers');
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(list.map((t: any) => t.id)).toEqual(['daily', 'poll']); // alphabetical

    const daily = list.find((t: any) => t.id === 'daily');
    expect(daily).toMatchObject({ name: 'wf-report', kind: 'cron', value: '0 9 * * *', maxAttempts: 3, misfire: 'skip', status: 'pending' });

    const poll = list.find((t: any) => t.id === 'poll');
    expect(poll).toMatchObject({ name: 'wf-sync', kind: 'every', value: 60_000, misfire: 'catchup', nextRunAt: 60_000, status: 'pending' });
  });

  it('an empty list if there are no triggers (not 500)', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal() });
    const res = await app.request('/scheduler/triggers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('returns an empty list if the journal is not writable/listKeys (same pattern as queue/jobs)', async () => {
    const bareReader = { listRuns: async () => [], readRun: async () => undefined };
    const app = createStudioApi({ reader: bareReader as any });
    const res = await app.request('/scheduler/triggers');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);
  });

  it('a failed trigger: lastError/lastErrorAt are reflected', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'f1', name: 'wf-fail', at: 0, maxAttempts: 1 }, 0);
    await pollScheduler(j, { runWorkflow: async () => { throw new Error('connection dropped'); } }, 0);

    const app = createStudioApi({ reader: j });
    const list = await (await app.request('/scheduler/triggers')).json();
    expect(list[0]).toMatchObject({ id: 'f1', status: 'failed', attempts: 1 });
    expect(list[0].lastError).toMatch(/connection dropped/);
  });

  it('401 without read permission', async () => {
    const app = createStudioApi({ reader: new InMemoryJournal(), auth: { read: () => false } });
    const res = await app.request('/scheduler/triggers');
    expect(res.status).toBe(401);
  });

  it('capabilities.scheduler: true for a writable + listKeys journal, false for a bare reader', async () => {
    const withJournal = createStudioApi({ reader: new InMemoryJournal() });
    const capsWith = await (await withJournal.request('/capabilities')).json();
    expect(capsWith.scheduler).toBe(true);

    const bareReader = { listRuns: async () => [], readRun: async () => undefined };
    const withoutJournal = createStudioApi({ reader: bareReader as any });
    const capsWithout = await (await withoutJournal.request('/capabilities')).json();
    expect(capsWithout.scheduler).toBe(false);
  });
});
