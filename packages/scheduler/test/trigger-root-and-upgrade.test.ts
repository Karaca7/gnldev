// R18: the scheduler's log is polled at the root, so an organization-scoped (or subject-view) journal is
// refused — before, `scheduleWorkflow(withOrg(root,'acme'), …)` filed the trigger where no root poller
// looks, and said nothing (measured: `ok`). The queue and the events bus already refused the analogue.
// R21: giving an existing system trigger an owner (an upgrade) does not double it (measured before:
// `~o~acme::nightly,nightly`, both firing).
// ADR-0002: each fire runs with the trigger's recorded owner as the caller; staff is said out loud.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, InMemoryStorage, withOrg, withSubjectJournal, createGnl, scopeConfigToOrg, runOwnerOf, user, staff, UNKNOWN, type Caller } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler, listTriggers, createScheduler, createWorkflowWaker, moveTrigger, type WorkflowRunner } from '../src/index.js';

const recorder = (calls: Array<[string, Caller | undefined]>): WorkflowRunner => ({
  async runWorkflow(name, _input, o) { calls.push([name, o?.caller]); return { runId: o?.runId ?? 'x' }; },
});

describe('the scheduler refuses a journal it would not poll', () => {
  const scoped = () => withOrg(new InMemoryJournal(), 'acme');
  it('scheduleWorkflow, pollScheduler and listTriggers on an organization\'s journal', async () => {
    await expect(scheduleWorkflow(scoped(), { name: 'n', every: 1000 }, 0)).rejects.toThrow(/ROOT journal/);
    await expect(pollScheduler(scoped(), recorder([]), 1)).rejects.toThrow(/ROOT journal/);
    await expect(listTriggers(scoped())).rejects.toThrow(/ROOT journal/);
  });
  it('createScheduler and the workflow waker, at construction', () => {
    expect(() => createScheduler(scoped(), recorder([]))).toThrow(/ROOT journal/);
    expect(() => createWorkflowWaker({ journal: scoped(), resume: async () => undefined })).toThrow(/ROOT journal/);
  });
  it('an end user\'s view', async () => {
    const view = withSubjectJournal(new InMemoryJournal() as never, 'ayse');
    await expect(scheduleWorkflow(view as never, { name: 'n', every: 1000 }, 0)).rejects.toThrow(/end user's view/);
  });
  it('the root journal still works', async () => {
    await expect(scheduleWorkflow(new InMemoryJournal(), { name: 'n', every: 1000 }, 0)).resolves.toBe('n');
  });
});

describe('each fire runs as the trigger\'s recorded owner', () => {
  it('user, explicit staff, and unknown for a trigger nobody owns', async () => {
    const j = new InMemoryJournal();
    const calls: Array<[string, Caller | undefined]> = [];
    await scheduleWorkflow(j, { id: 'u', name: 'wu', at: 0, caller: user('ayse') }, 0);
    await scheduleWorkflow(j, { id: 's', name: 'ws', at: 0, caller: staff() }, 0);
    await scheduleWorkflow(j, { id: 'n', name: 'wn', at: 0 }, 0);
    await pollScheduler(j, recorder(calls), 1);
    expect(Object.fromEntries(calls)).toEqual({ wu: user('ayse'), ws: staff(), wn: UNKNOWN });
  });

  it('caller and a different resourceId are refused: one owner per trigger', async () => {
    await expect(scheduleWorkflow(new InMemoryJournal(), { name: 'w', at: 0, caller: user('a'), resourceId: 'b' }, 0)).rejects.toThrow(/one owner per trigger/);
  });

  it('end to end: a staff trigger\'s run in an organization is born staff\'s, and no end user reads it', async () => {
    const storage = new InMemoryStorage();
    const wf = workflow<{ n: number }>().then(step('s', async (i) => ({ v: i.n })));
    const config = { storage, workflows: { w: wf } };
    const id = await scheduleWorkflow(storage.runs as never, { id: 'ops', name: 'w', input: { n: 1 }, at: 0, caller: staff('acme') }, 0);
    await pollScheduler(storage.runs as never, createGnl(config), 1, { runnerForOrg: (org) => createGnl(scopeConfigToOrg(config, org).config) });
    const acme = scopeConfigToOrg(config, 'acme').journal;
    const o = await runOwnerOf(acme as never, `sched:${id}:0`);
    expect(o.state === 'owned' ? o.owner : o.state).toEqual(staff('acme'));
  });
});

describe('moving a pre-upgrade trigger to its owner', () => {
  it('the post-upgrade boot finds the moved trigger: one trigger fires, as the owner', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { name: 'nightly', every: 1000 }, 0); // pre-upgrade boot
    const moved = await moveTrigger(j, 'nightly', { orgId: 'acme' });
    const after = await scheduleWorkflow(j, { name: 'nightly', every: 1000, orgId: 'acme' }, 0); // post-upgrade boot
    expect(after).toBe(moved);
    const calls: Array<[string, Caller | undefined]> = [];
    const r = await pollScheduler(j, recorder([]), 5000, { runnerForOrg: () => recorder(calls) });
    expect(r.fired).toBe(1);
    expect(calls).toHaveLength(1);
    const listed = await listTriggers(j);
    expect(listed.map((t) => [t.id, t.status, t.movedTo])).toEqual([
      ['nightly', 'done', moved],
      [moved, 'pending', undefined],
    ].sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
  });

  it('the fire count and the next time carry over, so no fire repeats an old run id', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { name: 'nightly', every: 1000 }, 0);
    await pollScheduler(j, recorder([]), 1000);
    await pollScheduler(j, recorder([]), 2000);
    const before = (await listTriggers(j)).find((t) => t.id === 'nightly')!;
    const moved = await moveTrigger(j, 'nightly', { caller: user('ayse') });
    const after = (await listTriggers(j)).find((t) => t.id === moved)!;
    expect({ fc: after.fireCount, next: after.nextRunAt, owner: after.resourceId }).toEqual({ fc: before.fireCount, next: before.nextRunAt, owner: 'ayse' });
  });

  it('refuses an owned trigger and an ownerless target; null for no such trigger', async () => {
    const j = new InMemoryJournal();
    const owned = await scheduleWorkflow(j, { name: 'w', every: 1000, orgId: 'acme' }, 0);
    await expect(moveTrigger(j, owned, { orgId: 'globex' })).rejects.toThrow(/already has an owner/);
    await scheduleWorkflow(j, { name: 'old', every: 1000 }, 0);
    await expect(moveTrigger(j, 'old', {})).rejects.toThrow(/needs an owner/);
    expect(await moveTrigger(j, 'missing', { orgId: 'acme' })).toBeNull();
  });
});
