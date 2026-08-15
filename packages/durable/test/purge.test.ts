// Retention/GDPR purge: ALL trace of the target run is deleted, NEIGHBORING runs are untouched.
// Since deletion is destructive, boundaries are specifically tested (prefix neighboring: r-1 vs r-10).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, purgeRun, purgeThread, sweepRuns, createGnl, netKeys } from '../src/index.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { createMockModel, finalTextResult } from './mock.js';

async function seed(journal: any) {
  await journal.put(runKeys.model('r-1', 0), { content: [], usage: {} });
  await journal.put(runKeys.tool('r-1', 'c1'), { status: 'succeeded', output: 1 });
  await journal.put(runKeys.input('r-1'), { prompt: 'secret personal data' });
  await journal.put(runKeys.cfgModel('r-1'), { spec: 'm/1' });
  await journal.put(runKeys.memAppended('r-1'), true);
  // NEIGHBORS: the 'r-1' prefix must NOT CAPTURE 'r-10'
  await journal.put(runKeys.model('r-10', 0), { content: [] });
  await journal.put(runKeys.model('other', 0), { content: [] });
}

describe.each([
  ['InMemory', () => new InMemoryJournal() as any],
  ['Sqlite', () => new SqliteStorage(':memory:').runs as any],
])('purgeRun (%s)', (_name, make) => {
  it("all trace of the target run is gone; neighbor (r-10) and other runs remain; dropped from listRuns", async () => {
    const journal = make();
    await seed(journal);

    const deleted = await purgeRun(journal, 'r-1');
    expect(deleted).toBeGreaterThanOrEqual(5);

    expect(await journal.get(runKeys.model('r-1', 0))).toBeUndefined();
    expect(await journal.get(runKeys.input('r-1'))).toBeUndefined(); // PII gone
    expect(await journal.get(runKeys.memAppended('r-1'))).toBeUndefined();
    // Neighbors intact
    expect(await journal.get(runKeys.model('r-10', 0))).toBeDefined();
    expect(await journal.get(runKeys.model('other', 0))).toBeDefined();

    const runs = await journal.listRuns();
    const ids = (Array.isArray(runs) ? runs : runs.items).map((r: any) => r.runId);
    expect(ids).not.toContain('r-1');
    expect(ids).toContain('r-10');
  });
});

describe('sweepRuns (retention TTL)', () => {
  // Controlled-timestamp stub: derives readRun/listRuns from the entries list.
  function stubJournal(runs: Record<string, { ts: number | undefined; suspended?: boolean }[]>) {
    const store = new Map<string, unknown>();
    for (const [rid, entries] of Object.entries(runs)) {
      entries.forEach((e, i) => store.set(`${rid}:${e.suspended ? 'tool' : 'model'}:${i}`, e.suspended ? { status: 'suspended', output: {} } : { content: [] }));
    }
    const meta = runs;
    return {
      store,
      async get(k: string) { return store.get(k); },
      async put(k: string, v: unknown) { store.set(k, v); },
      async deletePrefix(prefix: string) {
        let d = 0;
        for (const k of [...store.keys()]) if (k.startsWith(prefix)) { store.delete(k); d++; }
        return d;
      },
      async listRuns() { return Object.keys(meta).filter((rid) => [...store.keys()].some((k) => k.startsWith(rid + ':'))).map((runId) => ({ runId, status: 'completed', modelSteps: 0, toolCalls: 0 })); },
      async readRun(runId: string) {
        return (meta[runId] ?? []).map((e, i) => ({
          key: `${runId}:${e.suspended ? 'tool' : 'model'}:${i}`, runId,
          kind: (e.suspended ? 'tool' : 'model') as 'tool' | 'model',
          value: e.suspended ? { status: 'suspended', output: {} } : { content: [] },
          seq: i, ts: e.ts,
        })).filter((e) => store.has(e.key));
      },
    };
  }

  it('old completed ones are deleted; fresh, suspended, and timestamp-less ones are kept', async () => {
    const NOW = 1_000_000;
    const j = stubJournal({
      old: [{ ts: NOW - 10_000 }],
      fresh: [{ ts: NOW - 1_000 }],
      pending: [{ ts: NOW - 10_000 }, { ts: NOW - 10_000, suspended: true }], // old BUT suspended
      unclear: [{ ts: undefined }], // age unmeasurable → keep
    });
    const r = await sweepRuns(j as any, { olderThanMs: 5_000, now: NOW });
    expect(r.purged).toEqual(['old']);
    expect(r.keptSuspended).toBe(1);
    expect(r.keptNoTs).toBe(1);
    expect(await j.get('old:model:0')).toBeUndefined();
    expect(await j.get('fresh:model:0')).toBeDefined();
    expect(await j.get('pending:tool:1')).toBeDefined();

    // keepSuspended:false → the suspended-but-old one is deleted too
    const r2 = await sweepRuns(j as any, { olderThanMs: 5_000, now: NOW, keepSuspended: false });
    expect(r2.purged).toEqual(['pending']);
  });
});

describe('purgeRun network cascade', () => {
  // Network sub-agent journals aren't parent-prefixed (`net:<runId>:<i>`) → if not deleted with
  // a separate prefix, they're orphaned in GDPR purge (PII leak). Verifies the cascade actually deletes.
  const route = (agent: string, task: string) => JSON.stringify({ action: 'route', agent, task });
  const final = (answer: string) => JSON.stringify({ action: 'final', answer });

  it("both `<runId>:*` and network nested `net:<runId>:*` keys are deleted", async () => {
    const journal = new InMemoryJournal();
    let i = 0;
    const router = createMockModel(async () => {
      const answers = [route('expert', 'answer the question'), final('result: expert answer')];
      const text = answers[Math.min(i, answers.length - 1)]!;
      i++;
      return finalTextResult(text);
    });
    const gnl = createGnl({
      journal,
      agents: {
        expert: {
          description: 'domain expert',
          model: createMockModel(async () => finalTextResult('answer containing secret personal data')),
        },
      },
      networks: { support: { router, agents: ['expert'] } },
    });

    const res = await gnl.runNetwork('support', { runId: 'n1', task: 'question' });
    expect(res.steps).toHaveLength(1);

    // Precondition: both the parent network decisions (`n1:net:*`) and the sub-agent journal (`net:n1:0:*`) exist.
    const nestedId = netKeys.nestedRunId('n1', 0); // 'net:n1:0'
    const parentNetKeys = await journal.listKeys('n1:net:');
    const nestedKeys = await journal.listKeys(`${nestedId}:`);
    expect(parentNetKeys.length).toBeGreaterThan(0);
    expect(nestedKeys.length).toBeGreaterThan(0);
    expect(await journal.readRun(nestedId)).not.toEqual([]); // sub-agent really ran durably

    const deleted = await purgeRun(journal, 'n1');
    expect(deleted).toBeGreaterThanOrEqual(parentNetKeys.length + nestedKeys.length);

    // BOTH parent (`n1:*`) AND network nested (`net:n1:*`) are completely gone.
    expect(await journal.listKeys('n1:')).toHaveLength(0);
    expect(await journal.listKeys('net:n1:')).toHaveLength(0);
    expect(await journal.readRun(nestedId)).toEqual([]);
  });
});

describe('purge helpers', () => {
  it('purgeThread deletes the BasicMemory trace; a clear error when deletePrefix is missing', async () => {
    const journal = new InMemoryJournal();
    await journal.put('mem:th-1:messages', [{ role: 'user', content: 'personal' }]);
    await journal.put('mem:th-1:working', 'notes');
    await journal.put('mem:th-2:messages', [{ role: 'user', content: 'stays' }]);

    expect(await purgeThread(journal, 'th-1')).toBe(2);
    expect(await journal.get('mem:th-1:messages')).toBeUndefined();
    expect(await journal.get('mem:th-2:messages')).toBeDefined();

    const noDelete = { get: async () => undefined, put: async () => {} };
    await expect(purgeRun(noDelete as any, 'x')).rejects.toThrow('deletePrefix');
  });
});

describe('purgeRun agent-tool cascade (H5)', () => {
  it('real agent-as-tool flow: purgeRun(parent) also deletes the nested agent:<toolCallId> journal', async () => {
    const journal = new InMemoryJournal();
    // Parent model: calls the agent_expert tool → createAgentTool runs a nested runDurable.
    const { toolCallResult, countToolResults } = await import('./mock.js');
    const parentModel = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0
        ? toolCallResult('agent_expert', 'call-uz1', { task: 'process personal data' })
        : finalTextResult('done'),
    );
    const gnl = createGnl({
      journal,
      agents: {
        main: { model: parentModel, agents: ['expert'] },
        expert: { model: createMockModel(async () => finalTextResult('secret PII answer')) },
      },
    });
    await gnl.run('main', { runId: 'p1', prompt: 'task' });

    // Nested journal really got created (agent:<parentRunId>:<toolCallId>).
    expect((await journal.readRun('agent:p1:call-uz1')).length).toBeGreaterThan(0);

    await purgeRun(journal, 'p1');
    expect(await journal.readRun('p1')).toEqual([]);
    expect(await journal.readRun('agent:p1:call-uz1')).toEqual([]); // cascade: no orphaned PII
    expect(await journal.listKeys('agent:p1:call-uz1:')).toEqual([]);
  });

  it('deep chain: parent → agent → agent (grandchild) all deleted; neighboring agent run REMAINS', async () => {
    const journal = new InMemoryJournal();
    // Synthetic three levels (exact schema match): p2's tool is tc1 → agent:tc1's tool is tc2 → agent:tc2.
    await journal.put(runKeys.model('p2', 0), { content: [] });
    await journal.put(runKeys.tool('p2', 'tc1'), { status: 'succeeded', output: 1 });
    await journal.put(runKeys.model('agent:tc1', 0), { content: [] });
    await journal.put(runKeys.tool('agent:tc1', 'tc2'), { status: 'succeeded', output: 2 });
    await journal.put(runKeys.model('agent:tc2', 0), { content: ['grandchild PII'] });
    // NEIGHBOR: another parent's child — must not be touched.
    await journal.put(runKeys.model('agent:other', 0), { content: [] });

    await purgeRun(journal, 'p2');
    expect(await journal.readRun('agent:tc1')).toEqual([]);
    expect(await journal.readRun('agent:tc2')).toEqual([]); // grandchild gone too
    expect((await journal.readRun('agent:other')).length).toBe(1); // neighbor intact
  });

  it('network child\'s agent-tool grandchild is also cascaded (net → agent chain)', async () => {
    const journal = new InMemoryJournal();
    // p3's network step: nested run net:p3:0; that run called an agent-tool (tcX).
    await journal.put('p3:net:route:0', { v: { action: 'route', agent: 'a', task: 't' } });
    await journal.put(runKeys.model('net:p3:0', 0), { content: [] });
    await journal.put(runKeys.tool('net:p3:0', 'tcX'), { status: 'succeeded', output: 1 });
    await journal.put(runKeys.model('agent:tcX', 0), { content: ['deep PII'] });

    await purgeRun(journal, 'p3');
    expect(await journal.listKeys('p3:')).toEqual([]);
    expect(await journal.readRun('net:p3:0')).toEqual([]);
    expect(await journal.readRun('agent:tcX')).toEqual([]); // net→agent grandchild gone too
  });

  it('cycle safety: a synthetic chain pointing to itself does not enter an infinite loop', async () => {
    const journal = new InMemoryJournal();
    // agent:tcA's tool is tcA → its child is again agent:tcA (itself). Protected by seen-set.
    await journal.put(runKeys.tool('agent:tcA', 'tcA'), { status: 'succeeded', output: 1 });
    await journal.put(runKeys.model('agent:tcA', 0), { content: [] });
    const deleted = await purgeRun(journal, 'agent:tcA');
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await journal.readRun('agent:tcA')).toEqual([]);
  });
});

describe('purgeRun workflow-as-tool cascade', () => {
  it('workflow-as-tool child (`wf:<parent>:<tcid>`) is cascaded, registry record and all', async () => {
    // The agent cascade above stopped at `agent:` children, so a parent that started a WORKFLOW as a
    // tool was purged around its child: the workflow's step outputs and its top-level `wfrun:` record
    // survived the parent that owned them. @gnldev/durable stays structurally decoupled from
    // @gnldev/workflow (see registry.ts's WorkflowLike JSDoc), so the workflow below writes what the
    // real engine writes — a journaled step output under `<runId>:wf:<stepId>` (workflow.ts's runStep)
    // and the `wfrun:<runId>` status mirror (its putStatus) — without importing that package.
    const journal = new InMemoryJournal();
    const { toolCallResult, countToolResults } = await import('./mock.js');
    const parentModel = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0
        ? toolCallResult('workflow_onboarding', 'call-w1', { input: { orderId: '8812' } })
        : finalTextResult('done'),
    );
    const gnl = createGnl({
      journal,
      workflows: {
        onboarding: {
          build: () => [{ id: 'collect' }],
          run: async () => ({}),
          async runResumable(_input: unknown, ctx: { runId: string; journal: any }) {
            await ctx.journal.put(`${ctx.runId}:wf:collect`, { customer: 'secret personal data' });
            await ctx.journal.put(`wfrun:${ctx.runId}`, { runId: ctx.runId, status: 'completed', updatedAt: Date.now() });
            return { status: 'completed' as const, output: { shipped: true } };
          },
        },
      },
      agents: { clerk: { model: parentModel, workflows: ['onboarding'] } },
    });
    // NEIGHBORS in the same namespace: an unrelated parent's workflow child, and a runId that merely
    // EXTENDS the child's (`call-w1` vs `call-w10`) — the registry key has no terminator after the
    // runId, so a prefix delete of the child's record would take this one with it.
    await journal.put('wf:p-other:call-w1:wf:collect', { keep: true });
    await journal.put('wfrun:wf:p-other:call-w1', { runId: 'wf:p-other:call-w1', status: 'completed' });
    await journal.put('wfrun:wf:p-wf:call-w10', { runId: 'wf:p-wf:call-w10', status: 'completed' });

    await gnl.run('clerk', { runId: 'p-wf', prompt: 'onboard order 8812' });

    // Precondition: the workflow really ran durably under the parent-scoped nested id.
    const child = 'wf:p-wf:call-w1';
    expect(await journal.get(`${child}:wf:collect`)).toBeDefined();
    expect(await journal.get(`wfrun:${child}`)).toBeDefined();

    await purgeRun(journal, 'p-wf');

    expect(await journal.listKeys('p-wf:')).toEqual([]);
    expect(await journal.listKeys(`${child}:`)).toEqual([]); // no orphaned step output
    expect(await journal.get(`wfrun:${child}`)).toBeUndefined(); // and it stops advertising itself
    expect(await journal.get('wf:p-other:call-w1:wf:collect')).toBeDefined();
    expect(await journal.get('wfrun:wf:p-other:call-w1')).toBeDefined();
    expect(await journal.get('wfrun:wf:p-wf:call-w10')).toBeDefined(); // r-1 did not take r-10
  });

  it('legacy bare `wf:<toolCallId>` children are cascaded too; another parent\'s child REMAINS', async () => {
    const journal = new InMemoryJournal();
    // Synthetic, exact schema match — the pre-parent-scoping shape still sitting in older journals:
    // p4's tool is tcW → the workflow ran as `wf:tcW`, with a suspend reason in its registry record.
    await journal.put(runKeys.model('p4', 0), { content: [] });
    await journal.put(runKeys.tool('p4', 'tcW'), { status: 'succeeded', output: { suspended: true } });
    await journal.put('wf:tcW:wf:review', { applicant: 'PII in a step output' });
    await journal.put('wfrun:wf:tcW', { runId: 'wf:tcW', status: 'suspended', reason: 'needs a manager' });
    // NEIGHBOR: another parent's workflow child — must not be touched.
    await journal.put('wf:tcOther:wf:review', { applicant: 'stays' });
    await journal.put('wfrun:wf:tcOther', { runId: 'wf:tcOther', status: 'completed' });

    await purgeRun(journal, 'p4');
    expect(await journal.listKeys('wf:tcW:')).toEqual([]);
    expect(await journal.get('wfrun:wf:tcW')).toBeUndefined();
    expect(await journal.get('wf:tcOther:wf:review')).toBeDefined();
    expect(await journal.get('wfrun:wf:tcOther')).toBeDefined();
  });

  it('purging a workflow run of its own drops its registry record, without touching the r-10 neighbor', async () => {
    // Same key shape reached from the other direction: `purgeRun` on a TOP-LEVEL workflow run. The
    // record is not under `<runId>:`, so every prefix delete in purgeRun used to miss it and a swept
    // run kept showing up in listWorkflowRuns — with its suspend reason and waitId still readable.
    const journal = new InMemoryJournal();
    await journal.put('r-1:wf:review', { applicant: 'personal data' });
    await journal.put('wfrun:r-1', { runId: 'r-1', status: 'suspended', waitId: 'manager', reason: 'personal data' });
    await journal.put('wfrun:r-10', { runId: 'r-10', status: 'completed' });

    await purgeRun(journal, 'r-1');
    expect(await journal.get('wfrun:r-1')).toBeUndefined();
    expect(await journal.get('r-1:wf:review')).toBeUndefined();
    expect(await journal.get('wfrun:r-10')).toBeDefined();
  });
});
