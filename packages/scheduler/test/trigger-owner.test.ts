// A trigger set up for an end user fires as theirs, in their organization: the scheduler keeps whose it
// is and hands it to the run. A trigger with an organization is never run on an organization-less
// runner — that would write the user's work where their organization cannot see it.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner } from '../src/index.js';

type Call = { who: string; name: string; opts: Record<string, unknown> };
function recorder(who: string, calls: Call[]): WorkflowRunner {
  return { async runWorkflow(name, _input, opts) { calls.push({ who, name, opts: { ...opts } }); return { runId: opts?.runId ?? 'x' }; } };
}

describe('a trigger on behalf of an end user', () => {
  it('fires with the user as the run\'s resourceId', async () => {
    const j = new InMemoryJournal();
    const calls: Call[] = [];
    await scheduleWorkflow(j, { id: 't1', name: 'weekly', at: 0, resourceId: 'ayse' }, 0);
    await pollScheduler(j, recorder('default', calls), 1);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.opts.resourceId).toBe('ayse');
  });

  it('fires on its organization\'s runner, and only there', async () => {
    const j = new InMemoryJournal();
    const calls: Call[] = [];
    await scheduleWorkflow(j, { id: 't1', name: 'weekly', at: 0, resourceId: 'ayse', orgId: 'acme' }, 0);
    await pollScheduler(j, recorder('default', calls), 1, { runnerForOrg: (org) => recorder(`org:${org}`, calls) });
    expect(calls.map((c) => c.who)).toEqual(['org:acme']);
    expect(calls[0]!.opts.resourceId).toBe('ayse');
  });

  it('with an organization but no way to reach it, it does not run — and says why', async () => {
    const j = new InMemoryJournal();
    const calls: Call[] = [];
    // The id scheduleWorkflow returns is the stored one (`ownedName`: a name within its owner).
    const id = await scheduleWorkflow(j, { id: 't1', name: 'weekly', at: 0, orgId: 'acme', maxAttempts: 1 }, 0);
    await pollScheduler(j, recorder('default', calls), 1);
    expect(calls, 'the organization-less runner must not be used').toEqual([]);
    const t = (await listTriggers(j)).find((x) => x.id === id)!;
    expect(t.status).toBe('failed');
    expect(t.lastError).toMatch(/runnerForOrg/);
  });

  it('a system trigger is unchanged: default runner, no user', async () => {
    const j = new InMemoryJournal();
    const calls: Call[] = [];
    await scheduleWorkflow(j, { id: 's', name: 'nightly', at: 0 }, 0);
    await pollScheduler(j, recorder('default', calls), 1, { runnerForOrg: (org) => recorder(`org:${org}`, calls) });
    expect(calls.map((c) => c.who)).toEqual(['default']);
    expect(calls[0]!.opts.resourceId).toBeUndefined();
  });

  it('the listing says whose each trigger is', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'mine', name: 'w', every: 60_000, resourceId: 'ayse', orgId: 'acme' }, 0);
    const t = (await listTriggers(j))[0]!;
    expect({ r: t.resourceId, o: t.orgId }).toEqual({ r: 'ayse', o: 'acme' });
  });

  it('a malformed organization or an empty user is refused when the trigger is set', async () => {
    const j = new InMemoryJournal();
    await expect(scheduleWorkflow(j, { name: 'w', at: 0, orgId: 'a:b' })).rejects.toThrow(/invalid orgId/);
    await expect(scheduleWorkflow(j, { name: 'w', at: 0, resourceId: '' })).rejects.toThrow(/resourceId/);
  });
});
