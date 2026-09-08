// FAZ-8 (audit K14) — the /semantic-guard and /approvals.serverNow pins: aggregation, an additive
// field, and an honest 'unavailable' on a journal without listKeys (no empty-success lie).
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { createStudioApi } from '../../studio/src/server.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { call } from './call.js';

const get = (api: any, p: string) => call(api, p).then((r: any) => r.json());

describe('studio /semantic-guard + suspendedAt', () => {
  it('aggregates semantic incidents; /approvals carries serverNow and suspendedAt', async () => {
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: 'sg' } } };
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    const model = (id: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createProduct', id, args) : finalTextResult('done'));
    await runDurable({ runId: 'sg1', journal, model: model('c1', { sku: 'A', n: 1 }), tools, threadId: 'th', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);
    await runDurable({ runId: 'sg2', journal, model: model('c2', { sku: 'A', n: 2 }), tools, threadId: 'th', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any); // a semantic suspend

    const api = createStudioApi({ reader: journal });
    const sg = await get(api, '/semantic-guard');
    expect(sg.totals.suspend).toBe(1);
    expect(sg.byTool.createProduct.suspend).toBe(1);
    expect(sg.recent[0]).toMatchObject({ runId: 'sg2', action: 'suspend', toolName: 'createProduct' });
    expect(sg.scannedRuns).toBeGreaterThan(0);

    const ap = await get(api, '/approvals');
    expect(typeof ap.serverNow).toBe('number'); // K2: both ends of the age decision come from the server clock
    const item = ap.items.find((i: any) => i.runId === 'sg2');
    expect(item).toBeTruthy();
    expect(typeof item.suspendedAt).toBe('number');

    // precision@suspend — v2's data gate: with no decision there is NO rate (never invented from zero)
    expect(sg.precision).toEqual({ approved: 0, denied: 0, pending: 1, rate: null });

    // sg2 is DENIED (the gate caught a real duplicate); sg3 is a new suspension → APPROVED (run it anyway)
    await runDurable({ runId: 'sg2', journal, model: model('c2', { sku: 'A', n: 2 }), tools, threadId: 'th', limits, prompt: 'x', stopWhen: stepCountIs(6), approvals: { c2: false } } as any);
    await runDurable({ runId: 'sg3', journal, model: model('c3', { sku: 'A', n: 3 }), tools, threadId: 'th', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);
    await runDurable({ runId: 'sg3', journal, model: model('c3', { sku: 'A', n: 3 }), tools, threadId: 'th', limits, prompt: 'x', stopWhen: stepCountIs(6), approvals: { c3: true } } as any);
    const sg2 = await get(api, '/semantic-guard');
    expect(sg2.totals.suspend).toBe(2);
    expect(sg2.precision).toEqual({ approved: 1, denied: 1, pending: 0, rate: 0.5 });
  });

  it("a journal without listKeys answers honestly, via the unavailable field", async () => {
    const m = new Map<string, unknown>();
    const plain: any = {
      async get(k: string) { return m.get(k); },
      async put(k: string, v: unknown) { m.set(k, v); },
      async listRuns() { return []; },
      async readRun() { return []; },
    };
    const api = createStudioApi({ reader: plain });
    const sg = await get(api, '/semantic-guard');
    expect(sg.unavailable).toContain('listKeys');
    expect(sg.totals).toEqual({ suspend: 0, warn: 0 });
    expect(sg.precision).toEqual({ approved: 0, denied: 0, pending: 0, rate: null }); // shape parity
  });

  it("FAZ-7 (H16-d): 'semantic-judge' records are VISIBLE in the summary, with the byOrigin breakdown", async () => {
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const cert = {
      v: 1 as const, fixtureSetId: 'fx', judgeModelId: 'jm', judgePromptVersion: '1',
      paraphraseRecall: 0.9, nearMissFp: 0.02, passedAt: Date.now(),
    };
    const limits = {
      sideEffectDuplicates: {
        action: 'suspend' as const, scope: 'thread' as const,
        semantic: {
          embed, embedModelId: 'sg2', rules: true as const,
          judge: { complete: async () => 'SAME', judgeModelId: 'jm', qualification: cert },
        },
      },
    };
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'], describe: () => 'create' }, execute: async () => ({ ok: 1 }) } };
    const model = (id: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createProduct', id, args) : finalTextResult('done'));
    await runDurable({ runId: 'jv1', journal, model: model('c1', { sku: 'coupon code invalid' }), tools, threadId: 'thj', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);
    await runDurable({ runId: 'jv2', journal, model: model('c2', { sku: 'discount code not working' }), tools, threadId: 'thj', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);

    const api = createStudioApi({ reader: journal });
    const sg = await get(api, '/semantic-guard');
    expect(sg.totals.suspend).toBe(1); // the judge's question was COUNTED (the old filter could not see it)
    expect(sg.byOrigin).toEqual({ identity: 0, rule: 0, judge: 1 });
    expect(sg.recent[0]).toMatchObject({ runId: 'jv2', action: 'suspend', source: 'semantic-judge' });
  });

  it('staleReplaced reaches the summary: a model swap\'s invalidation cost is countable', async () => {
    // The regression this pins: the flag was produced by the judge, declared in the UI type and
    // counted by the server — but never copied into the incident, so the field was a permanent zero
    // and the promise "you can see what a model swap cost you" was quietly false.
    //
    // Staging note: re-asking the SAME pair needs the same incoming args, and those would be caught
    // by the exact-hash marker one layer above — so the marker is removed and the cached verdict's
    // model stamp is aged by hand, which is precisely the state a real model swap leaves behind.
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const cert = {
      v: 1 as const, fixtureSetId: 'fx', judgeModelId: 'jm', judgePromptVersion: '1',
      paraphraseRecall: 0.9, nearMissFp: 0.02, passedAt: Date.now(),
    };
    const limits = {
      sideEffectDuplicates: {
        action: 'suspend' as const, scope: 'thread' as const,
        semantic: { embed, embedModelId: 'sr', rules: true as const,
          judge: { complete: async () => 'DIFFERENT', judgeModelId: 'jm', qualification: cert } },
      },
    };
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'], describe: () => 'create' }, execute: async () => ({ ok: 1 }) } };
    const model = (id: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createProduct', id, args) : finalTextResult('done'));
    const run = (runId: string, id: string, sku: string) =>
      runDurable({ runId, journal, model: model(id, { sku }), tools, threadId: 'ths', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);

    await run('sr1', 'c1', 'coupon code invalid');
    await run('sr2', 'c2', 'discount code not working'); // judge asked; verdict cached under 'jm'

    const [jk] = await journal.listKeys!('xthr:ths:semjudge-');
    expect(jk).toBeTruthy();
    const cached = await journal.get<any>(jk!);
    await journal.put(jk!, { ...cached, judgeModelId: 'an-older-model' }); // the swap's leftover
    for (const k of await journal.listKeys!('xthr:ths:dup-')) await journal.deletePrefix!(k);

    await run('sr3', 'c3', 'discount code not working'); // same pair → stale stamp → re-asked
    const sg = await get(createStudioApi({ reader: journal }), '/semantic-guard');
    expect(sg.judge.staleReplaced).toBe(1);
  });

  it('byDeclaration: a waved-through question names the identity fields it rested on', async () => {
    // The loop this closes: `precision` can say a question was wrong, but not what to change. The
    // measured failure it comes from — a tool matching on `sku` alone while the field that actually
    // separated the two jobs (the warehouse) was absent from the tool's schema, so the engine
    // compared everything it could see and every value agreed.
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: 'bd' } } };
    // `qty` is deliberately OUTSIDE keys: the two calls are different jobs, and nothing in the
    // declaration can tell them apart. This is the false alarm, staged.
    const tools = { createOrder: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    const model = (id: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createOrder', id, args) : finalTextResult('done'));
    const run = (runId: string, id: string, args: unknown, approvals?: Record<string, boolean>) =>
      runDurable({ runId, journal, model: model(id, args), tools, threadId: 'thd', limits, prompt: 'x', stopWhen: stepCountIs(6), ...(approvals ? { approvals } : {}) } as any);

    await run('bd1', 'c1', { sku: 'AC-12000', qty: 18 });
    await run('bd2', 'c2', { sku: 'AC-12000', qty: 10 }); // asked — same sku, and sku is all it knows
    await run('bd2', 'c2', { sku: 'AC-12000', qty: 10 }, { c2: true }); // human: "different warehouse, run it"

    const sg = await get(createStudioApi({ reader: journal }), '/semantic-guard');
    expect(sg.byDeclaration).toEqual([{ toolName: 'createOrder', keys: ['sku'], suspend: 1, approved: 1, denied: 0 }]);
    expect(sg.precision).toMatchObject({ approved: 1, denied: 0 });
  });

  it('a confirm tool records its repeat question too — the answer used to evaporate', async () => {
    // Found by running it, not by reading it. `confirm: true` fires BEFORE the semantic recall hook,
    // so on a confirm tool the gate did all its work (the question carries the ⚠ line) and then
    // returned without journalling anything. The human answered a repeat question and the answer was
    // gone. precision@suspend read EMPTY on the tools most worth measuring — and empty looks exactly
    // like "no questions were asked" rather than "we never wrote them down".
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: 'cf' } } };
    const tools = { createOrder: { sideEffect: true, confirm: true as const, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    const model = (id: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createOrder', id, args) : finalTextResult('done'));
    const run = (runId: string, id: string, args: unknown, approvals?: Record<string, boolean>) =>
      runDurable({ runId, journal, model: model(id, args), tools, threadId: 'thc', limits, prompt: 'x', stopWhen: stepCountIs(6), ...(approvals ? { approvals } : {}) } as any);

    await run('cf1', 'c1', { sku: 'AC-12000', qty: 18 });            // confirm asks
    await run('cf1', 'c1', { sku: 'AC-12000', qty: 18 }, { c1: true }); // approved → runs, sem record written
    await run('cf2', 'c2', { sku: 'AC-12000', qty: 9 });             // confirm asks, now DECORATED
    await run('cf2', 'c2', { sku: 'AC-12000', qty: 9 }, { c2: false }); // human: really a duplicate

    const sg = await get(createStudioApi({ reader: journal }), '/semantic-guard');
    expect(sg.totals.suspend).toBe(1);
    expect(sg.byOrigin).toMatchObject({ identity: 1 });
    expect(sg.precision).toMatchObject({ approved: 0, denied: 1, rate: 1 });
    // The API reports the declaration with the answer attached; it does not pre-filter. Nothing was
    // waved through here, so `approved` is 0 — and that is what keeps the row off the UI's repair
    // list. Filtering server-side would throw away the working declarations, which are the baseline
    // a reader needs to judge the broken ones against.
    expect(sg.byDeclaration).toEqual([{ toolName: 'createOrder', keys: ['sku'], suspend: 1, approved: 0, denied: 1 }]);
  });

  it('an ORDINARY confirm question is not a dedup event', async () => {
    // The other half of the rule. confirm asks on every fresh call by design; counting those denials
    // as "the gate caught a duplicate" would fill precision@suspend with clicks about something else.
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: 'cf' } } };
    const tools = { createOrder: { sideEffect: true, confirm: true as const, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createOrder', 'c1', { sku: 'FIRST-EVER' }) : finalTextResult('done'));
    await runDurable({ runId: 'cfo1', journal, model, tools, threadId: 'thn', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);

    const sg = await get(createStudioApi({ reader: journal }), '/semantic-guard');
    expect(sg.totals).toEqual({ suspend: 0, warn: 0 });
  });

  it('a question recorded before identityKeys existed is omitted, not shown with an empty key list', async () => {
    // `[]` on screen would read as "this tool declares no identity fields" — a different and far
    // more alarming claim than "we did not record it back then". The row disappears instead.
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: 'bd' } } };
    const tools = { createOrder: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    const model = (id: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createOrder', id, args) : finalTextResult('done'));
    const run = (runId: string, id: string, args: unknown) =>
      runDurable({ runId, journal, model: model(id, args), tools, threadId: 'tho', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);

    // Different qty on purpose: byte-identical args are caught by the exact-hash marker one layer
    // above and the semantic gate never runs — the record this test ages would not exist.
    await run('od1', 'c1', { sku: 'AC-12000', qty: 18 });
    await run('od2', 'c2', { sku: 'AC-12000', qty: 10 });
    // Age the record into the shape an older build wrote: everything else, no identityKeys.
    for (const k of await journal.listKeys!('od2:incident:')) {
      const hit = await journal.get<any>(k); // stored wrapped as { v: incident }
      if (hit?.v?.action !== 'suspend') continue;
      const { identityKeys: _dropped, ...detail } = hit.v.detail;
      await journal.put(k, { v: { ...hit.v, detail } });
    }

    const sg = await get(createStudioApi({ reader: journal }), '/semantic-guard');
    expect(sg.totals.suspend).toBe(1); // the question itself still counts everywhere else
    expect(sg.byDeclaration).toEqual([]);
  });
});
