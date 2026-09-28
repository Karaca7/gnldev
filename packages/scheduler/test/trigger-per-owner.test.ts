// A trigger id names a trigger WITHIN its owner. Triggers of every organization live in one journal,
// and the id defaults to the workflow's name, so the second user (or organization) to schedule the same
// workflow got the first one's id back — "already scheduled" — and their trigger never existed.
// The budget hook could not tell whose trigger was firing, and a waker scanning the root never saw a
// sleeping workflow inside an organization.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, InMemoryStorage, createGnl, scopeConfigToOrg, toJournal, userIdOf } from '@gnldev/durable';
import { workflow, step, sleep } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler, listTriggers, createWorkflowWaker, type WorkflowRunner } from '../src/index.js';

const recorder = (calls: unknown[]): WorkflowRunner => ({
  async runWorkflow(name, input, o) { calls.push([name, input, userIdOf(o?.caller)]); return { runId: o?.runId ?? 'x' }; },
});

describe('trigger ids belong to their owner', () => {
  it('two users scheduling the same workflow without an id get two triggers, each firing as its own', async () => {
    const j = new InMemoryJournal();
    const a = await scheduleWorkflow(j, { name: 'weekly', at: 0, input: 'A', resourceId: 'ayse', orgId: 'acme' }, 0);
    const b = await scheduleWorkflow(j, { name: 'weekly', at: 0, input: 'B', resourceId: 'bora', orgId: 'globex' }, 0);
    expect(b).not.toBe(a);
    const calls: unknown[] = [];
    await pollScheduler(j, recorder(calls), 1, { runnerForOrg: () => recorder(calls) });
    expect(calls).toEqual(expect.arrayContaining([['weekly', 'A', 'ayse'], ['weekly', 'B', 'bora']]));
    expect(calls).toHaveLength(2);
  });

  it('one owner repeating an id is still idempotent; a system trigger keeps its id as given', async () => {
    const j = new InMemoryJournal();
    const a1 = await scheduleWorkflow(j, { id: 't', name: 'w', at: 0, resourceId: 'ayse', orgId: 'acme' }, 0);
    expect(await scheduleWorkflow(j, { id: 't', name: 'w', at: 0, resourceId: 'ayse', orgId: 'acme' }, 0)).toBe(a1);
    expect(await scheduleWorkflow(j, { id: 'nightly', name: 'w', at: 0 }, 0)).toBe('nightly');
    expect((await listTriggers(j)).length).toBe(2);
  });
});

describe('the budget hook knows whose trigger it is', () => {
  it('receives the organization and the user', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { name: 'w', at: 0, resourceId: 'ayse', orgId: 'acme' }, 0);
    const seen: unknown[] = [];
    await pollScheduler(j, recorder([]), 1, { runnerForOrg: () => recorder([]), budgetGuard: (c) => { seen.push([c.orgId, c.resourceId]); } });
    expect(seen).toEqual([['acme', 'ayse']]);
  });
});

describe('the waker reaches organizations', () => {
  it('wakes a sleeping workflow inside an organization, and says which one', async () => {
    const storage = new InMemoryStorage();
    const wf = workflow<unknown>().then(sleep('nap', Date.now() + 10)).then(step('after', async () => 'woke'));
    const config = { storage, workflows: { napper: wf } };
    const acme = createGnl(scopeConfigToOrg(config, 'acme').config);
    expect((await acme.runWorkflow('napper', {}, { runId: 'nap-1', resourceId: 'ayse' })).suspended).toBe(true);
    const resume = vi.fn(async () => {});
    const waker = createWorkflowWaker({ journal: toJournal(storage.runs) as never, resume, orgs: ['acme', 'globex'] });
    const t = await waker.tick(Date.now() + 1000);
    expect(t.resumed).toBe(1);
    expect(resume.mock.calls[0]![0]).toBe('nap-1');
    expect(resume.mock.calls[0]![2]).toEqual({ orgId: 'acme' });
    // Once per wake: the ticket lives in the organization's partition too.
    expect((await waker.tick(Date.now() + 1000)).resumed).toBe(0);
  });
});
