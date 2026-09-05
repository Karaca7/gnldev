// FAZ-8 (denetçi K14) — /semantic-guard + /approvals.serverNow pinleri: toplulaştırma, additive alan,
// listKeys'siz journal'da dürüst 'unavailable' (boş-başarı yalanı yok).
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { createStudioApi } from '../../studio/src/server.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';
import { call } from './call.js';

const get = (api: any, p: string) => call(api, p).then((r: any) => r.json());

describe('studio /semantic-guard + suspendedAt', () => {
  it('semantik incident\'ları toplulaştırır; /approvals serverNow + suspendedAt taşır', async () => {
    const journal = new InMemoryJournal();
    const embed = async (texts: string[]) => texts.map(() => [1, 0, 0]);
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: 'sg' } } };
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    const model = (id: string, args: unknown) => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('createProduct', id, args) : finalTextResult('done'));
    await runDurable({ runId: 'sg1', journal, model: model('c1', { sku: 'A', n: 1 }), tools, threadId: 'th', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any);
    await runDurable({ runId: 'sg2', journal, model: model('c2', { sku: 'A', n: 2 }), tools, threadId: 'th', limits, prompt: 'x', stopWhen: stepCountIs(6) } as any); // semantik suspend

    const api = createStudioApi({ reader: journal });
    const sg = await get(api, '/semantic-guard');
    expect(sg.totals.suspend).toBe(1);
    expect(sg.byTool.createProduct.suspend).toBe(1);
    expect(sg.recent[0]).toMatchObject({ runId: 'sg2', action: 'suspend', toolName: 'createProduct' });
    expect(sg.scannedRuns).toBeGreaterThan(0);

    const ap = await get(api, '/approvals');
    expect(typeof ap.serverNow).toBe('number'); // K2: yaş kararının iki ucu sunucu saatinden
    const item = ap.items.find((i: any) => i.runId === 'sg2');
    expect(item).toBeTruthy();
    expect(typeof item.suspendedAt).toBe('number');
  });

  it("listKeys'siz journal: unavailable alanıyla dürüst cevap", async () => {
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
  });
});
