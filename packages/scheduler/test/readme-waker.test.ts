// The README's `createWorkflowWaker` example, run against workflows an end user owns.
//
// Release finding W-6: the example resumed with `runWorkflow(name, undefined, { runId })` and no
// caller. A resume that names nobody is `unknown`, which is refused on a user's run
// (RunOwnerMismatchError): every user-owned sleeping workflow stayed asleep, and the waker swallowed
// the error. The resume below is the README's, character for character (the first test pins that).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { InMemoryStorage, createGnl, scopeConfigToOrg, toJournal, runOwnerOf, withOrg, STAFF } from '@gnldev/durable';
import { workflow, step, sleep, listWorkflowRuns, type WorkflowRunIdentity } from '@gnldev/workflow';
import { createWorkflowWaker } from '../src/index.js';

const README_RESUME = `  resume: (runId, status, where) =>
    (where ? gnlFor(where.orgId) : gnl).runWorkflow(status.workflowName, undefined, { runId, caller: STAFF }),`;

afterEach(() => { vi.useRealTimers(); });

describe('the scheduler README waker example', () => {
  it('is the resume this test runs', () => {
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
    expect(readme).toContain(README_RESUME);
    expect(readme).toContain("import { STAFF, toJournal } from '@gnldev/durable';");
  });

  it('wakes a user-owned sleeping workflow, in the root and in an organization, and it continues as that user', async () => {
    const storage = new InMemoryStorage();
    const seen: WorkflowRunIdentity[] = [];
    // The deadline is fixed at definition; the waker is ticked with a clock past it.
    const wf = workflow<unknown>()
      .then(sleep('nap', Date.now() + 60_000))
      .then(step('after', async (_i, ctx) => { seen.push(ctx.identity); return 'woke'; }));
    const config = { storage, workflows: { napper: wf } };
    const gnl = createGnl(config);
    const gnlFor = (orgId: string) => createGnl(scopeConfigToOrg(config, orgId).config);

    expect((await gnl.runWorkflow('napper', {}, { runId: 'nap-root', resourceId: 'ayse' })).suspended).toBe(true);
    expect((await gnlFor('acme').runWorkflow('napper', {}, { runId: 'nap-org', resourceId: 'bora' })).suspended).toBe(true);

    const errors: unknown[] = [];
    const waker = createWorkflowWaker({
      journal: toJournal(storage.runs),
      orgs: ['acme'],
      // README_RESUME, as code:
      resume: (runId, status, where) =>
        (where ? gnlFor(where.orgId) : gnl).runWorkflow(status.workflowName, undefined, { runId, caller: STAFF }),
      onError: (_runId, e) => { errors.push(e); },
    });
    // Past the deadline for the waker AND for the resumed sleep step, which reads the clock itself.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 120_000);
    const t = await waker.tick(Date.now());
    expect(errors).toEqual([]);
    expect(t.resumed).toBe(2);

    const root = toJournal(storage.runs);
    expect((await listWorkflowRuns(root, { status: 'completed' })).map((r) => r.runId)).toEqual(['nap-root']);
    expect((await listWorkflowRuns(withOrg(root, 'acme') as never, { status: 'completed' })).map((r) => r.runId)).toEqual(['nap-org']);

    // Continued as the RECORDED owner, not as staff.
    expect(seen.map((i) => (i.kind === 'user' ? i.id : i.kind)).sort()).toEqual(['ayse', 'bora']);
    const owner = await runOwnerOf(root as never, 'nap-root');
    expect(owner.state === 'owned' && owner.owner).toMatchObject({ kind: 'user', id: 'ayse' });
  });
});
