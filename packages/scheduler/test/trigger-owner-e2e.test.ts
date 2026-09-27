// The whole chain, with no fakes in it: a trigger set for Ayşe in acme fires on acme's real instance,
// the run lands in acme's partition stamped as hers, and the end-user view that the server hands a
// caller lists it for her and for nobody else.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl, scopeConfigToOrg, withSubjectJournal } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
import { scheduleWorkflow, pollScheduler } from '../src/index.js';

describe('a scheduled workflow for an end user, end to end', () => {
  it('runs in her organization, as hers, and only she (and staff) can read it', async () => {
    const storage = new InMemoryStorage();
    const wf = workflow<{ week: number }>().then(step('summarise', async (i) => ({ text: `SUMMARY-W${i.week}` })));
    const config = { storage, workflows: { weekly: wf } };
    const gnlFor = (orgId: string) => createGnl(scopeConfigToOrg(config, orgId).config);

    // Triggers live in the platform journal; the runs they start live in each organization's.
    const platform = createGnl(config);
    await scheduleWorkflow(storage.runs as never, { id: 'ayse-weekly', name: 'weekly', input: { week: 39 }, at: 0, resourceId: 'ayse', orgId: 'acme' }, 0);
    const r = await pollScheduler(storage.runs as never, platform, 1, { runnerForOrg: gnlFor });
    expect(r.fired).toBe(1);

    const runId = 'sched:ayse-weekly:0';
    const step0 = `${runId}:wf:summarise`;
    const acme = scopeConfigToOrg(config, 'acme').journal as never;
    expect(await (acme as any).get(step0)).toEqual({ text: 'SUMMARY-W39' });
    const listed = async (who: string) => ((await withSubjectJournal(acme, who).listRuns!()) as Array<{ runId: string }>).map((r) => r.runId);
    expect(await listed('ayse')).toContain(runId);
    expect(await listed('mallory')).not.toContain(runId);
    // Stamped as hers at birth — which is what every other end-user gate reads.
    expect(await (acme as any).get(`${runId}:input`)).toMatchObject({ resourceId: 'ayse' });
    // Not in the platform partition, and not in another organization's.
    expect(await storage.runs.get(step0)).toBeUndefined();
    expect(await (scopeConfigToOrg(config, 'globex').journal as any).get(step0)).toBeUndefined();
  });
});
