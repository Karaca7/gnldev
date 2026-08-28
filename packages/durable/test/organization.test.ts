// withOrg: journal scoped to an organization — the same runId is independent across different
// organizations, exactly-once guarantees are preserved per organization, the read surface (listRuns) is isolated.
import { describe, it, expect } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import type { Journal } from '../src/journal.js';
import { withOrg } from '../src/organization.js';
import { acquireRunLock } from '../src/run-lock.js';
import { getOrgUsage, USAGE_KEY } from '../src/budget.js';
import { runDurable } from '../src/run.js';
import { createMockModel, toolCallResult, finalTextResult, countToolResults } from './mock.js';

function agentModel(text: string) {
  return createMockModel(async (options: any) =>
    countToolResults(options.prompt) === 0
      ? toolCallResult('charge', 'call-1', { amount: 10 })
      : finalTextResult(text),
  );
}

function makeTools(counter: { charges: number }) {
  return {
    charge: tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }: { amount: number }) => {
        counter.charges++;
        return { charged: amount };
      },
    }),
  };
}

describe('withOrg: journal scoped to an organization', () => {
  it('same runId is independent across two organizations; exactly-once is preserved within an organization', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    const globex = withOrg(shared, 'globex');
    const cAcme = { charges: 0 };
    const cGlobex = { charges: 0 };

    await runDurable({ runId: 'order-1', journal: acme, model: agentModel('acme done'), tools: makeTools(cAcme), prompt: 'charge', stopWhen: stepCountIs(4) } as any);
    await runDurable({ runId: 'order-1', journal: globex, model: agentModel('globex done'), tools: makeTools(cGlobex), prompt: 'charge', stopWhen: stepCountIs(4) } as any);
    // Same runId — but the organizations are isolated: both made their own charge
    expect(cAcme.charges).toBe(1);
    expect(cGlobex.charges).toBe(1);

    // Resume (acme): replay — the charge does NOT run AGAIN; globex is unaffected
    const r = await runDurable({ runId: 'order-1', journal: acme, model: agentModel('acme done'), tools: makeTools(cAcme), prompt: 'charge', stopWhen: stepCountIs(4) } as any);
    expect(r.text).toBe('acme done');
    expect(cAcme.charges).toBe(1);
    expect(cGlobex.charges).toBe(1);
  });

  it('read surface is isolated: each organization sees only its own runs (with the unprefixed runId)', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    const globex = withOrg(shared, 'globex');
    await runDurable({ runId: 'r-a', journal: acme, model: agentModel('a'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);
    await runDurable({ runId: 'r-g', journal: globex, model: agentModel('g'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);

    const acmeRuns = await (acme as any).listRuns();
    expect(acmeRuns.map((r: any) => r.runId)).toEqual(['r-a']); // unprefixed + itself only
    const entries = await (acme as any).readRun('r-a');
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(e.runId).toBe('r-a'); // the prefix doesn't leak
      expect(e.key.startsWith('org:')).toBe(false); // the 'org:' storage prefix doesn't leak outside the view
    }
    // In the shared raw journal, the keys really are prefixed (the mechanism behind isolation)
    expect(shared.keys().some((k) => k.startsWith('org:acme:'))).toBe(true);
    expect(shared.keys().some((k) => k.startsWith('org:globex:'))).toBe(true);
  });

  it("orgId must not contain ':' / must not be empty", () => {
    const j = new InMemoryJournal();
    expect(() => withOrg(j, 'a:b')).toThrow('must not contain');
    expect(() => withOrg(j, '')).toThrow();
  });
});

// AUDIT (capability-loss fix): withOrg previously only bridged get/put/putIfAbsent/listKeys/
// deletePrefix/readRun/listRuns — putIfMatch/now/incrBy/getCounters/listStaleRuns/readRunStats
// SILENTLY disappeared in the org view (atomic lock takeover fell back to best-effort, budget
// counters fell back to legacy). This block tests that every bridge exists + org isolation.
describe('withOrg: optional capability bridges (no capability loss)', () => {
  it('putIfMatch works as an atomic CAS in the org view and is org-isolated', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    const globex = withOrg(shared, 'globex');
    await acme.put('k', 'v1');
    await globex.put('k', 'other');

    expect(await acme.putIfMatch!('k', 'v1', 'v2')).toBe(true);   // expected matched → changed
    expect(await acme.putIfMatch!('k', 'v1', 'v3')).toBe(false);  // now v2 → CAS rejects
    expect(await acme.get('k')).toBe('v2');
    expect(await globex.get('k')).toBe('other'); // the other organization is UNAFFECTED
  });

  it('if the underlying journal does not offer putIfMatch, the org view does not either (no false atomicity promise)', () => {
    const bare: Journal = { get: async () => undefined, put: async () => {} };
    const view = withOrg(bare, 'acme');
    expect(view.putIfMatch).toBeUndefined();
    expect(view.incrBy).toBeUndefined();
    expect(view.now).toBeUndefined();
  });

  it('run-lock: of two workers racing to take over an expired lock in the org view, ONLY ONE succeeds (CAS)', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    const stale = await acquireRunLock(acme, 'r1', 'w-old', 10, 1_000);
    expect(stale).not.toBeNull(); // acquired at t=1000, stale at t=1010

    const [a, b] = await Promise.all([
      acquireRunLock(acme, 'r1', 'w-a', 60_000, 5_000),
      acquireRunLock(acme, 'r1', 'w-b', 60_000, 5_000),
    ]);
    const winners = [a, b].filter(Boolean);
    expect(winners).toHaveLength(1); // without the putIfMatch bridge, best-effort put → BOTH would "win"
  });

  it('incrBy/getCounters work in the org view and are org-isolated; the budget counter path (getOrgUsage) is O(1) in the org view', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    const globex = withOrg(shared, 'globex');

    await acme.incrBy!(USAGE_KEY, { runs: 2, tokens: 100, costUsd: 0.5 });
    expect(await acme.getCounters!(USAGE_KEY)).toEqual({ runs: 2, tokens: 100, costUsd: 0.5 });
    expect(await globex.getCounters!(USAGE_KEY)).toBeUndefined(); // isolation

    // budget.ts:getOrgUsage calls withOrg internally → finds the counter path thanks to the bridge
    // (without the bridge: getCounters undefined → would fall back to the legacy full-scan fallback).
    const usage = await getOrgUsage(shared, 'acme', undefined, /* strictSuspendedCost */ false);
    expect(usage).toEqual({ runs: 2, tokens: 100, costUsd: 0.5 });
  });

  it('now() is delegated as-is (no prefix — time is global)', async () => {
    const bare: Journal = { get: async () => undefined, put: async () => {}, now: async () => 42_000 };
    const view = withOrg(bare, 'acme');
    expect(await view.now!()).toBe(42_000);
  });

  it("listStaleRuns is org-isolated: only its own org's stale runs, with the prefix STRIPPED", async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    const globex = withOrg(shared, 'globex');
    await runDurable({ runId: 'r-a', journal: acme, model: agentModel('a'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);
    await runDurable({ runId: 'r-g', journal: globex, model: agentModel('g'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);

    const stale = await acme.listStaleRuns!(Date.now() + 60_000); // cutoff in the future → all are stale
    expect(stale).toEqual(['r-a']); // only acme's, unprefixed; globex's does NOT leak
  });

  it('readRunStats works in the org view by prefixing runId', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    await runDurable({ runId: 'r-a', journal: acme, model: agentModel('a'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);

    const stats = await (acme as any).readRunStats('r-a');
    expect(stats.entries).toBeGreaterThan(0);
    expect(stats.bytes).toBeGreaterThan(0);
  });
});

// P0.3 (AUDIT-R2): InMemoryJournal.listRunsPaged (direct) + its withOrg bridge — the
// headline correctness property for an org-scoped paginated read: org A must NEVER see org B's runs
// through the paged path, exactly like the existing (unpaged) listRuns bridge above.
describe('P0.3: listRunsPaged (InMemoryJournal direct + withOrg bridge)', () => {
  it('InMemoryJournal.listRunsPaged: filters (status/agent) + offset-cursor pagination', async () => {
    const j = new InMemoryJournal();
    await j.put('lp-a:input', { prompt: 'x', agent: 'alpha' });
    await j.put('lp-a:model:0', { ok: true });
    await j.put('lp-b:input', { prompt: 'x', agent: 'beta' });
    await j.put('lp-b:model:0', { ok: true });
    await j.put('lp-b:tool:t1', { status: 'suspended', output: {} });
    await j.put('lp-c:model:0', { ok: true }); // no :input → no agent

    const all = await j.listRunsPaged();
    expect(all.items.map((r) => r.runId).sort()).toEqual(['lp-a', 'lp-b', 'lp-c']);

    const suspended = await j.listRunsPaged({ status: 'suspended' });
    expect(suspended.items.map((r) => r.runId)).toEqual(['lp-b']);

    const alpha = await j.listRunsPaged({ agent: 'alpha' });
    expect(alpha.items.map((r) => r.runId)).toEqual(['lp-a']);

    const p1 = await j.listRunsPaged({ limit: 1 });
    expect(p1.items.length).toBe(1);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await j.listRunsPaged({ limit: 1, cursor: p1.nextCursor });
    const p3 = await j.listRunsPaged({ limit: 1, cursor: p2.nextCursor });
    expect(p3.nextCursor).toBeUndefined();
    expect([...p1.items, ...p2.items, ...p3.items].map((r) => r.runId).sort()).toEqual(['lp-a', 'lp-b', 'lp-c']);
  });

  it('withOrg: listRunsPaged is bridged — org A cannot see org B\'s runs through the paged path', async () => {
    const shared = new InMemoryJournal();
    const acme = withOrg(shared, 'acme');
    const globex = withOrg(shared, 'globex');
    await runDurable({ runId: 'r-a1', journal: acme, model: agentModel('a1'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);
    await runDurable({ runId: 'r-a2', journal: acme, model: agentModel('a2'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);
    await runDurable({ runId: 'r-g1', journal: globex, model: agentModel('g1'), tools: makeTools({ charges: 0 }), prompt: 'x', stopWhen: stepCountIs(4) } as any);

    expect(typeof acme.listRunsPaged).toBe('function');
    const acmePage = await acme.listRunsPaged!();
    expect(acmePage.items.map((r) => r.runId).sort()).toEqual(['r-a1', 'r-a2']); // unprefixed, globex invisible
    for (const r of acmePage.items) expect(r.runId.startsWith('org:')).toBe(false); // prefix doesn't leak

    const globexPage = await globex.listRunsPaged!();
    expect(globexPage.items.map((r) => r.runId)).toEqual(['r-g1']);

    // pagination through the org walk still lands on exactly this org's runs (no cross-org leak/undercount).
    const p1 = await acme.listRunsPaged!({ limit: 1 });
    expect(p1.items.length).toBe(1);
    const seen = [...p1.items];
    let cursor = p1.nextCursor;
    // Bounded on purpose. `while (cursor)` reads as harmless until the day a cursor stops advancing —
    // and then the failure mode is a test suite that HANGS rather than one that goes red, which is
    // strictly worse to debug. The bound is a decade past the two rows this fixture holds, so it can
    // only fire on a genuine non-terminating cursor.
    for (let guard = 0; cursor; guard++) {
      expect(guard, 'pagination did not terminate — the cursor is not advancing').toBeLessThan(20);
      const page = await acme.listRunsPaged!({ limit: 1, cursor });
      seen.push(...page.items);
      cursor = page.nextCursor;
    }
    expect(seen.map((r) => r.runId).sort()).toEqual(['r-a1', 'r-a2']);
    // A repeat would otherwise hide inside the sort above.
    expect(new Set(seen.map((r) => r.runId)).size).toBe(seen.length);
  });

  it('withOrg: if the underlying journal has no listRunsPaged, the org view does not either', () => {
    const bare: Journal = { get: async () => undefined, put: async () => {} };
    const view = withOrg(bare, 'acme');
    expect(view.listRunsPaged).toBeUndefined();
  });
});
