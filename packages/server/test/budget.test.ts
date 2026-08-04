// Runtime budget enforcement: a new run request from an org that's over budget gets 402; resume is exempt; /usage reports it.
// Limit source: journal `__budget__:*` (managed by Studio) > opts.budgets fallback.
import { describe, it, expect } from 'vitest';
import { tool } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, BUDGET_PRE } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(tokens = 10): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'm',
    supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text: 'ok' }],
      finishReason: 'stop',
      usage: { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens },
      warnings: [],
    }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

const run = (api: any, org: string | undefined, runId: string) =>
  call(api, '/agents/a/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(org ? { 'x-gnl-org': org } : {}) },
    body: JSON.stringify({ runId, prompt: 'hi' }),
  });

describe('@gnldev/server budget enforcement', () => {
  it('once the journal budget is exceeded, a new run gets 402 (usage + limit in the body); other orgs are unaffected', async () => {
    const journal = new InMemoryJournal();
    await journal.put(BUDGET_PRE + 'acme', { tokenLimit: 15 });
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel(10) } } },
      { org: {} },
    );

    expect((await run(api, 'acme', 'r1')).status).toBe(200); // 10 tokens — under the limit
    const blocked = await run(api, 'acme', 'r2'); // usage 10 so far; before the second run 10 < 15 → passes
    expect(blocked.status).toBe(200); // 10 ≤ 15: not exceeded yet (total becomes 20)
    const third = await run(api, 'acme', 'r3'); // now 20 > 15 → 402
    expect(third.status).toBe(402);
    const body = await third.json();
    expect(body.usage.tokens).toBe(20);
    expect(body.limit).toEqual({ tokenLimit: 15 });

    expect((await run(api, 'globex', 'r1')).status).toBe(200); // isolated org is unaffected
  });

  it('opts.budgets fallback is enforced; the journal limit overrides it', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel(10) } } },
      { org: {}, budgets: { perOrg: { acme: { tokenLimit: 5 } } } },
    );
    expect((await run(api, 'acme', 'r1')).status).toBe(200); // first run: usage 0 ≤ 5
    expect((await run(api, 'acme', 'r2')).status).toBe(402); // 10 > 5

    // Studio scenario: a higher limit in the journal overrides the fallback. The gate reads the
    // journal LIVE on every request (no stale 402 cache) → opens immediately on the SAME instance.
    await journal.put(BUDGET_PRE + 'acme', { tokenLimit: 1000 });
    expect((await run(api, 'acme', 'r3')).status).toBe(200);
  });

  it('F3: with org enabled, the default budget does NOT apply to the ROOT (org-less) scope — it stays per-org', async () => {
    const journal = new InMemoryJournal();
    // acme + globex will together use 20 tokens; default limit is 15 (total > limit).
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel(10) } } },
      { org: {}, budgets: { default: { tokenLimit: 15 } } },
    );
    expect((await run(api, 'acme', 'a1')).status).toBe(200);   // acme: 10 ≤ 15
    expect((await run(api, 'globex', 'g1')).status).toBe(200); // globex: 10 ≤ 15 (isolated)

    // Org-less (root) request: even though the global total is 20 > 15, the per-org default does NOT apply to the root scope → 200.
    expect((await run(api, undefined as any, 'root1')).status).toBe(200);

    // /usage root scope: usage is reported but limit is null (root is not an org).
    const usage = await (await call(api, '/usage')).json();
    expect(usage.org).toBeNull();
    expect(usage.limit).toBeNull();
    expect(usage.exceeded).toBe(false);

    // The org scope still gets 402 once it's exceeded (per-org enforcement isn't broken).
    expect((await run(api, 'acme', 'a2')).status).toBe(200);   // acme total 20 > 15 → the next one is blocked
    expect((await run(api, 'acme', 'a3')).status).toBe(402);
  });

  it('2.2: with org DISABLED, opts.budgets.default is genuinely ENFORCED at the root scope (global cap)', async () => {
    const journal = new InMemoryJournal();
    // the org option is not given at all → scope() falls back to the shared defaultInstance (orgId undefined).
    const api = createRestApi(
      { journal, agents: { a: { model: mkModel(10) } } },
      { budgets: { default: { tokenLimit: 15 } } },
    );

    expect((await run(api, undefined, 'r1')).status).toBe(200); // 10 ≤ 15
    expect((await run(api, undefined, 'r2')).status).toBe(200); // usage before the check is 10 ≤ 15 (total becomes 20)
    const blocked = await run(api, undefined, 'r3'); // now 20 > 15 → 402
    expect(blocked.status).toBe(402);
    const body = await blocked.json();
    expect(body.usage.tokens).toBe(20);
    expect(body.limit).toEqual({ tokenLimit: 15 });

    // /usage also reports the limit at the root scope (with org disabled, root == the single global scope).
    const usage = await (await call(api, '/usage')).json();
    expect(usage.org).toBeNull();
    expect(usage.limit).toEqual({ tokenLimit: 15 });
    expect(usage.exceeded).toBe(true);
  });

  it('GET /usage reports the scope\'s usage + effective limit', async () => {
    const journal = new InMemoryJournal();
    await journal.put(BUDGET_PRE + 'acme', { tokenLimit: 100 });
    const api = createRestApi({ journal, agents: { a: { model: mkModel(10) } } }, { org: {} });
    await run(api, 'acme', 'r1');

    const res = await (await call(api, '/usage', { headers: { 'x-gnl-org': 'acme' } })).json();
    expect(res.org).toBe('acme');
    expect(res.usage.tokens).toBe(10);
    expect(res.limit).toEqual({ tokenLimit: 100 });
    expect(res.exceeded).toBe(false);

    // the org-less root scope also works (no limit → null)
    const root = await (await call(api, '/usage')).json();
    expect(root.org).toBeNull();
    expect(root.limit).toBeNull();
  });

  describe('1.2/1.3 — resume intent bypasses the budget gate (new work is still ENFORCED)', () => {
    it('H2: a suspended workflow in an over-budget org completes with 200 using the SAME runId; a new workflow gets 402', async () => {
      const journal = new InMemoryJournal();
      await journal.put(BUDGET_PRE + 'acme', { tokenLimit: 15 });
      // Minimal suspend/resume mock workflow: suspends without a `_suspend` marker, completes once it has one.
      const wf = {
        build: () => [{ id: 'step1' }],
        async runResumable(input: any, ctx: { runId: string; journal: any }) {
          const done = await ctx.journal.get(`${ctx.runId}:wf:step1`);
          if (done !== undefined) return { status: 'completed' as const, output: done };
          const suspended = await ctx.journal.get(`${ctx.runId}:wf:_suspend`);
          if (!suspended) {
            await ctx.journal.put(`${ctx.runId}:wf:_suspend`, { stepId: 'step1' });
            return { status: 'suspended' as const, stepId: 'step1' };
          }
          const output = { done: true, echo: input };
          await ctx.journal.put(`${ctx.runId}:wf:step1`, output);
          return { status: 'completed' as const, output };
        },
      };
      const api = createRestApi(
        { journal, agents: { a: { model: mkModel(10) } }, workflows: { wf } },
        { org: {} },
      );
      const post = (path: string, body: any) =>
        call(api, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
          body: JSON.stringify(body),
        });

      // First call while under budget: new runId → the gate applies but passes (usage 0), the workflow suspends.
      const first = await (await post('/workflows/wf/run', { runId: 'w1', input: { q: 1 } })).json();
      expect(first.ok).toBe(true);
      expect(first.suspended).toBe(true);

      // Exceed the budget (same pattern as budget.test's first scenario — 3rd run gets 402).
      expect((await run(api, 'acme', 'r1')).status).toBe(200);
      expect((await run(api, 'acme', 'r2')).status).toBe(200);
      expect((await run(api, 'acme', 'r3')).status).toBe(402); // now exceeded

      // A new workflow (different runId, no prior trace) → budget is STILL enforced (no regression) → 402.
      const freshBlocked = await post('/workflows/wf/run', { runId: 'w2', input: { q: 2 } });
      expect(freshBlocked.status).toBe(402);

      // Resume the suspended workflow with the SAME runId → COMPLETES with 200 even though the budget is exceeded.
      const resumed = await (await post('/workflows/wf/run', { runId: 'w1', input: { q: 1 } })).json();
      expect(resumed.ok).toBe(true);
      expect(resumed.suspended).toBe(false);
      expect(resumed.output).toEqual({ done: true, echo: { q: 1 } });
    });

    it('1.3: a suspended agent stream (approvals+runId) in an over-budget org completes with 200; a new stream gets 402', async () => {
      const journal = new InMemoryJournal();
      await journal.put(BUDGET_PRE + 'acme', { tokenLimit: 15 });
      const charges = { n: 0 };
      const tools = {
        chargeCard: tool({
          description: 'charge',
          inputSchema: z.object({ amount: z.number() }),
          execute: async ({ amount }: any) => {
            charges.n++;
            return { charged: amount };
          },
        }),
      };
      const guard = ({ toolName, args }: any) =>
        toolName === 'chargeCard' && args.amount > 1000 ? { action: 'require-approval' as const } : { action: 'allow' as const };
      const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
      const mkStream = (arr: any[]) =>
        new ReadableStream({
          start(c) {
            for (const p of arr) c.enqueue(p);
            c.close();
          },
        });
      const payModel: any = {
        specificationVersion: 'v2',
        provider: 'mock',
        modelId: 'm',
        supportedUrls: {},
        doGenerate: async () => { throw new Error('no gen'); },
        doStream: async ({ prompt }: any) => {
          const done = (prompt ?? []).filter((mm: any) => mm.role === 'tool').length;
          if (done === 0) {
            return {
              stream: mkStream([
                { type: 'stream-start', warnings: [] },
                { type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) },
                { type: 'finish', finishReason: 'tool-calls', usage },
              ]),
            };
          }
          return {
            stream: mkStream([
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: '1' },
              { type: 'text-delta', id: '1', delta: 'Done.' },
              { type: 'text-end', id: '1' },
              { type: 'finish', finishReason: 'stop', usage },
            ]),
          };
        },
      };
      const api = createRestApi(
        { journal, agents: { a: { model: mkModel(10) }, pay: { model: payModel, tools, guard, maxSteps: 6 } } },
        { org: {} },
      );
      const stream = (body: any) =>
        call(api, '/agents/pay/stream', {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
          body: JSON.stringify(body),
        });

      // Suspend while under budget (interrupt) — new runId, gate passes (usage 0). The SSE body's
      // tool steps aren't processed until it's consumed (same readSSE pattern as sse.test.ts) → consume with .text().
      const suspend = await stream({ runId: 'o1', prompt: 'charge' });
      expect(suspend.status).toBe(200);
      await suspend.text();
      expect(charges.n).toBe(0);

      // Exceed the budget.
      expect((await run(api, 'acme', 'r1')).status).toBe(200);
      expect((await run(api, 'acme', 'r2')).status).toBe(200);
      expect((await run(api, 'acme', 'r3')).status).toBe(402);

      // A new stream run (different runId, no prior trace) → budget is STILL enforced → 402.
      const freshBlocked = await stream({ runId: 'o2', prompt: 'charge' });
      expect(freshBlocked.status).toBe(402);

      // Resume the suspended interrupt with the SAME runId + approvals → 200 even though the budget is
      // exceeded, and the tool runs exactly-once (behavior CONSISTENT with /agents/:name/resume). /stream is not a
      // self-contained resume (only /agents/:name/resume reads its input from the journal) → the prompt must be resent.
      const resumed = await stream({ runId: 'o1', prompt: 'charge', approvals: { 'call-c': true } });
      expect(resumed.status).toBe(200);
      await resumed.text();
      expect(charges.n).toBe(1);
    });

    // Non-streaming doGenerate-based approval flow (same pattern as the mkModel in server.test.ts) —
    // shared across the resume-intent tests for /agents/:name/run and /agents/:name/resume.
    function mkPayModel(): any {
      return {
        specificationVersion: 'v2',
        provider: 'mock',
        modelId: 'm',
        supportedUrls: {},
        doGenerate: async ({ prompt }: any) => {
          const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
          const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
          if (done === 0) {
            return { content: [{ type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) }], finishReason: 'tool-calls', usage, warnings: [] };
          }
          return { content: [{ type: 'text', text: 'Done.' }], finishReason: 'stop', usage, warnings: [] };
        },
        doStream: async () => { throw new Error('no stream'); },
      };
    }

    it('/agents/:name/run: a suspended approval (approvals+same runId) in an over-budget org completes with 200; a new run gets 402', async () => {
      const journal = new InMemoryJournal();
      await journal.put(BUDGET_PRE + 'acme', { tokenLimit: 15 });
      const charges = { n: 0 };
      const tools = {
        chargeCard: tool({
          description: 'charge',
          inputSchema: z.object({ amount: z.number() }),
          execute: async ({ amount }: any) => { charges.n++; return { charged: amount }; },
        }),
      };
      const guard = ({ toolName, args }: any) =>
        toolName === 'chargeCard' && args.amount > 1000 ? { action: 'require-approval' as const } : { action: 'allow' as const };
      const api = createRestApi(
        { journal, agents: { a: { model: mkModel(10) }, pay: { model: mkPayModel(), tools, guard, maxSteps: 6 } } },
        { org: {} },
      );
      const post = (path: string, body: any) =>
        call(api, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
          body: JSON.stringify(body),
        });

      // Suspend while under budget (new runId → the gate applies but passes, usage 0).
      const suspend = await (await post('/agents/pay/run', { runId: 'o1', prompt: 'charge' })).json();
      expect(suspend.ok).toBe(true);
      expect(suspend.interrupts.length).toBe(1);
      expect(charges.n).toBe(0);

      // Exceed the budget.
      expect((await run(api, 'acme', 'r1')).status).toBe(200);
      expect((await run(api, 'acme', 'r2')).status).toBe(200);
      expect((await run(api, 'acme', 'r3')).status).toBe(402);

      // A new run (different runId, no prior trace) → budget is STILL enforced (no regression) → 402.
      const freshBlocked = await post('/agents/pay/run', { runId: 'o2', prompt: 'charge' });
      expect(freshBlocked.status).toBe(402);

      // Complete the suspended approval via /run with the SAME runId + approvals → 200 even though the budget is
      // exceeded, charge exactly once — behavior CONSISTENT with /stream and /workflows/:name/run.
      const resumed = await (await post('/agents/pay/run', { runId: 'o1', prompt: 'charge', approvals: { 'call-c': true } })).json();
      expect(resumed.ok).toBe(true);
      expect(resumed.text).toContain('Done');
      expect(charges.n).toBe(1);
    });

    it('/agents/:name/resume: only a GENUINE resume (a trace exists in the journal) bypasses the budget gate; a spoofed (traceless) runId still gets 402', async () => {
      const journal = new InMemoryJournal();
      await journal.put(BUDGET_PRE + 'acme', { tokenLimit: 15 });
      const charges = { n: 0 };
      const tools = {
        chargeCard: tool({
          description: 'charge',
          inputSchema: z.object({ amount: z.number() }),
          execute: async ({ amount }: any) => { charges.n++; return { charged: amount }; },
        }),
      };
      const guard = ({ toolName, args }: any) =>
        toolName === 'chargeCard' && args.amount > 1000 ? { action: 'require-approval' as const } : { action: 'allow' as const };
      const api = createRestApi(
        { journal, agents: { a: { model: mkModel(10) }, pay: { model: mkPayModel(), tools, guard, maxSteps: 6 } } },
        { org: {} },
      );
      const post = (path: string, body: any) =>
        call(api, path, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-gnl-org': 'acme' },
          body: JSON.stringify(body),
        });

      // Suspend while under budget (a genuine trace is written to the journal).
      const suspend = await (await post('/agents/pay/run', { runId: 'o1', prompt: 'charge' })).json();
      expect(suspend.interrupts.length).toBe(1);
      expect(charges.n).toBe(0);

      // Exceed the budget.
      expect((await run(api, 'acme', 'r1')).status).toBe(200);
      expect((await run(api, 'acme', 'r2')).status).toBe(200);
      expect((await run(api, 'acme', 'r3')).status).toBe(402);

      // Abuse attempt: a direct /resume call with a runId that never existed — no trace in the
      // journal → the "resume intent" check returns false → the budget gate is ENFORCED (no backdoor).
      const fake = await post('/agents/pay/resume', { runId: 'never-existed', approvals: {} });
      expect(fake.status).toBe(402);
      const fakeBody = await fake.json();
      expect(fakeBody.code).toBe('budget_exceeded');
      expect(charges.n).toBe(0);

      // Complete the genuinely suspended approval via /resume → a trace exists in the journal → gate is bypassed → 200, charge once.
      const resumed = await (await post('/agents/pay/resume', { runId: 'o1', approvals: { 'call-c': true } })).json();
      expect(resumed.ok).toBe(true);
      expect(resumed.text).toContain('Done');
      expect(charges.n).toBe(1);
    });
  });
});
