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
});
