// ADR-0002 5a, sibling: a queued job whose handler starts a WORKFLOW (not an agent) on the job's runId.
// The worker has already recorded the job's owner on that runId, so the workflow runs as the owner
// with ctx.caller, is refused without it, and suspends/resumes as the owner.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, scopeConfigToOrg, runOwnerOf, toJournal, withOrgStorage, withSubjectJournal, user } from '../src/index.js';
import { workflow, step, sleep } from '../../workflow/src/index.js';
import { enqueue, createWorker } from '../../queue/src/index.js';

describe('a job that runs a workflow', () => {
  it('runs as the job\'s owner with ctx.caller, and only she reads it', async () => {
    const storage = new InMemoryStorage();
    const wf = workflow<{ week: number }>().then(step('s', async (i) => ({ text: `W${i.week}` })));
    const config = { storage, workflows: { weekly: wf } };
    const id = await enqueue(storage.work!, 'weekly', { week: 39 }, { resourceId: 'ayse', orgId: 'acme' });
    await createWorker(storage, {
      weekly: async (p, ctx) => createGnl(scopeConfigToOrg(config, ctx.orgId!).config).runWorkflow('weekly', p, { runId: ctx.runId, caller: ctx.caller }),
    }).drain();
    const acme = toJournal(withOrgStorage(storage, 'acme').runs);
    const o = await runOwnerOf(acme, `job:${id}`);
    expect(o.state === 'owned' ? o.owner : o.state).toEqual(user('ayse', 'acme'));
    expect(await acme.get(`job:${id}:wf:s`)).toEqual({ text: 'W39' });
    const listed = async (who: string) => ((await withSubjectJournal(acme as never, who).listRuns!()) as Array<{ runId: string }>).map((r) => r.runId);
    expect(await listed('ayse')).toContain(`job:${id}`);
    expect(await listed('mallory')).not.toContain(`job:${id}`);
  });

  it('a handler that starts it without the caller is refused', async () => {
    const storage = new InMemoryStorage();
    const wf = workflow<unknown>().then(step('s', async () => 'x'));
    const gnl = createGnl({ storage, workflows: { w: wf } });
    await enqueue(storage.work!, 'w', {}, { resourceId: 'ayse' });
    const errors: unknown[] = [];
    await createWorker(storage, { w: async (p, ctx) => gnl.runWorkflow('w', p, { runId: ctx.runId }) }, { maxAttempts: 1, onError: (e) => errors.push(e) }).drain();
    expect(String(errors[0])).toMatch(/belongs to a different subject/);
  });

  it('a workflow that suspends in the job keeps the job\'s owner', async () => {
    const storage = new InMemoryStorage();
    const wf = workflow<unknown>().then(sleep('nap', Date.now() + 60_000)).then(step('after', async () => 'woke'));
    const gnl = createGnl({ storage, workflows: { napper: wf } });
    const id = await enqueue(storage.work!, 'nap', {}, { resourceId: 'ayse' });
    const results: unknown[] = [];
    await createWorker(storage, { nap: async (_p, ctx) => { results.push((await gnl.runWorkflow('napper', {}, { runId: ctx.runId, caller: ctx.caller })).suspended); } }).drain();
    expect(results).toEqual([true]);
    const o = await runOwnerOf(toJournal(storage.runs), `job:${id}`);
    expect(o.state === 'owned' ? o.owner : o.state).toEqual(user('ayse'));
  });
});
