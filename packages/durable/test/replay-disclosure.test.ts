// Replay-disclosure: modelin "oluşturdum" yalanına karşı dürüst anlatım katmanı. Pinlenenler:
// 1) 'explain': pencere-replay'inde model, İZLEYEN adımda geçici [gnl] notunu görür ve zarf dolar
// 2) default ('silent'): davranış bayt-aynı — NOT YOK; zarf yine dolar (out-of-band her zaman)
// 3) not KALICI DEĞİL: bir sonraki run'ın (yeni istek) model girdisinde eski not yoktur
// 4) kalıcı kural korunur: not, araç ÇAĞRILDIKTAN ve journal cevapladıktan sonra düşer — ilk
//    (taze) çağrının hiçbir adımında not yoktur (karar anına sızma yok)
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { BasicMemory } from '../src/memory.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

function orderTool(state: { n: number }) {
  return {
    ok: {
      description: 'sipariş',
      sideEffect: true,
      idempotency: 'args' as const,
      idempotencyWindow: 'thread' as const,
      recover: async () => ({ done: false as const }),
      execute: async (args: unknown) => { state.n += 1; return { ok: true, order: args }; },
    },
  };
}

/** Model: ilk adımda araç çağırır, sonra biter; her adımın PROMPT'unu yakalar. */
function capturingModel(callId: string, args: unknown, prompts: string[]) {
  return createMockModel(async ({ prompt }: any) => {
    prompts.push(JSON.stringify(prompt));
    return countToolResults(prompt) === 0 ? toolCallResult('ok', callId, args) : finalTextResult('done');
  });
}

const ARGS = { sku: 'abc', qty: 2 };
const base = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown>) => ({
  runId, journal, stopWhen: stepCountIs(4), prompt: 'sipariş ver', threadId: 'th-1', ...extra,
});

describe('replay-disclosure', () => {
  it("'explain': pencere-replay'i izleyen adımda geçici [gnl] notu + zarf; taze çağrıda not YOK", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const p1: string[] = [];
    const r1 = await runDurable(base(journal, 'rd-1', {
      model: capturingModel('c1', ARGS, p1), tools: orderTool(state), replayDisclosure: 'explain',
    }) as any);
    expect(state.n).toBe(1);
    expect(p1.join()).not.toContain('[gnl]'); // taze iş: hiçbir adımda not yok (karar anı temiz)
    expect((r1 as any).replayedToolCalls).toBeUndefined();

    // Aynı thread, YENİ runId, AYNI argümanlar → pencere replay'i: iş koşmaz, not düşer, zarf dolar.
    const p2: string[] = [];
    const r2 = await runDurable(base(journal, 'rd-2', {
      model: capturingModel('c2', ARGS, p2), tools: orderTool(state), replayDisclosure: 'explain',
    }) as any);
    expect(state.n).toBe(1); // exactly-once bozulmadı
    expect(p2.length).toBeGreaterThan(1);
    expect(p2[0]).not.toContain('[gnl]'); // araç ÇAĞRILMADAN önce yok
    expect(p2[p2.length - 1]).toContain('[gnl]'); // sonucu anlatırken var
    expect((r2 as any).replayedToolCalls).toEqual([
      expect.objectContaining({ toolName: 'ok', status: 'succeeded', origin: 'window' }),
    ]);

    // Not kalıcı DEĞİL: üçüncü run (farklı argümanlar = taze iş) geçmişinde eski notu görmez.
    const p3: string[] = [];
    await runDurable(base(journal, 'rd-3', {
      model: capturingModel('c3', { sku: 'xyz', qty: 1 }, p3), tools: orderTool(state), replayDisclosure: 'explain',
    }) as any);
    expect(p3.join()).not.toContain('[gnl]');
    expect(state.n).toBe(2);
  });

  it("default 'silent': not YOK ama zarf yine dolar (out-of-band damga koşulsuz)", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    await runDurable(base(journal, 'rs-1', { model: capturingModel('c1', ARGS, []), tools: orderTool(state) }) as any);
    const p2: string[] = [];
    const r2 = await runDurable(base(journal, 'rs-2', { model: capturingModel('c2', ARGS, p2), tools: orderTool(state) }) as any);
    expect(state.n).toBe(1);
    expect(p2.join()).not.toContain('[gnl]'); // mevcut davranış bayt-aynı
    expect((r2 as any).replayedToolCalls).toHaveLength(1); // damga yine var
  });
});

describe('replay-disclosure — denetçi bulguları', () => {
  it("not thread MEMORY'ye yazılmaz: memory bağlıyken sonraki turn'ün yüklenen geçmişinde [gnl] yok (K15)", async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const state = { n: 0 };
    // Memory'li koşularda geçmiş, tool-result İÇEREN mesajlar taşır — mock, sayaca değil kendi
    // adım sayısına bakmalı (yoksa ilk adımda 'final' der, araç hiç çağrılmaz — yaşandı).
    const stepModel = (callId: string, prompts: string[]) => createMockModel(async ({ prompt }: any) => {
      prompts.push(JSON.stringify(prompt));
      return prompts.length === 1 ? toolCallResult('ok', callId, ARGS) : finalTextResult('done');
    });
    await runDurable(base(journal, 'rm-1', {
      model: stepModel('c1', []), tools: orderTool(state), memory, replayDisclosure: 'explain',
    }) as any);
    // pencere-replay'li tur: not modele düşer AMA memory'ye yazılmamalı
    const p2: string[] = [];
    await runDurable(base(journal, 'rm-2', {
      model: stepModel('c2', p2), tools: orderTool(state), memory, replayDisclosure: 'explain',
    }) as any);
    expect(p2[p2.length - 1]).toContain('[gnl]');
    // ÜÇÜNCÜ turn: memory'den yüklenen geçmiş model girdisine girer — notu İÇERMEMELİ.
    const p3: string[] = [];
    await runDurable(base(journal, 'rm-3', {
      model: capturingModel('c3', { sku: 'q', qty: 9 }, p3), tools: orderTool(state), memory, replayDisclosure: 'explain',
    }) as any);
    expect(p3[0]).toContain('sipariş ver'); // geçmiş gerçekten yükleniyor (negatif test trivial değil)
    expect(p3.join()).not.toContain('[gnl]');
    const stored = await memory.getMessages('th-1');
    expect(JSON.stringify(stored)).not.toContain('[gnl]');
  });

  it("SELF origin: onay-resume'unda kendi kaydının consume'u NOT ÜRETMEZ, zarf 'self' etiketler (K4)", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = {
      ...orderTool(state),
      onayli: {
        description: 'onay ister', sideEffect: true, confirm: true, recover: async () => ({ done: false as const }),
        execute: async () => { state.n += 1; return { ok: 2 }; },
      },
    };
    // model: adım1 A(ok) → adım2 B(onaylı) → adım3 final
    const script = (prompts: string[]) => createMockModel(async ({ prompt }: any) => {
      prompts.push(JSON.stringify(prompt));
      const n = countToolResults(prompt);
      if (n === 0) return toolCallResult('ok', 'a1', ARGS);
      if (n === 1) return toolCallResult('onayli', 'b1', {});
      return finalTextResult('bitti');
    });
    const p1: string[] = [];
    const r1 = await runDurable(base(journal, 'self-1', { model: script(p1), tools, replayDisclosure: 'explain' }) as any);
    expect(r1.interrupts).toHaveLength(1); // B askıda
    // onayla resume: A'nın kaydı consume edilir (SELF) — canlı final adımında not OLMAMALI
    const p2: string[] = [];
    const r2 = await runDurable(base(journal, 'self-1', {
      model: script(p2), tools, replayDisclosure: 'explain', approvals: { b1: true },
    }) as any);
    expect(r2.interrupts).toHaveLength(0);
    expect(state.n).toBe(2); // A bir kez + B bir kez
    expect(p2.join()).not.toContain('[gnl]'); // kendi isteğinin devamı "önceki istek" diye anlatılmaz
    const env = (r2 as any).replayedToolCalls ?? [];
    expect(env.some((e: any) => e.origin === 'self')).toBe(true); // gözlemlenebilirlik kaybolmaz
    expect(env.every((e: any) => e.origin === 'self')).toBe(true);
  });

  it('processors ile kompozisyon: processInputStep VAR + explain → ikisi de çalışır (K14)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const seen = { steps: 0 };
    const proc = { name: 'sayan', processInputStep: () => { seen.steps += 1; return undefined; } };
    await runDurable(base(journal, 'pc-1', {
      model: capturingModel('c1', ARGS, []), tools: orderTool(state), replayDisclosure: 'explain', processors: [proc],
    }) as any);
    const p2: string[] = [];
    await runDurable(base(journal, 'pc-2', {
      model: capturingModel('c2', ARGS, p2), tools: orderTool(state), replayDisclosure: 'explain', processors: [proc],
    }) as any);
    expect(seen.steps).toBeGreaterThan(0); // processor hattı bozulmadı
    expect(p2[p2.length - 1]).toContain('[gnl]'); // not, kompoze prepareStep üstünden yine düştü
    expect(state.n).toBe(1);
  });
});

describe('confirm sorusunda tekrar bağlamı', () => {
  it('tamamlanmış thread-marker varken confirm sorusu ⚠ tekrar uyarısı taşır; taze soruda taşımaz; onay yeni işi AÇAR', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = {
      ok: {
        description: 'sipariş', sideEffect: true, confirm: true,
        recover: async () => ({ done: false as const }),
        execute: async (args: unknown) => { state.n += 1; return { ok: true, order: args }; },
      },
    };
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const } };
    const reasonOf = (r: any) => r.interrupts[0]?.reason ?? '';

    // r1: taze iş → generic confirm sorusu (⚠ YOK)
    const r1 = await runDurable(base(journal, 'cf-1', { model: capturingModel('c1', ARGS, []), tools, limits }) as any);
    expect(reasonOf(r1)).toContain('explicit confirmation');
    expect(reasonOf(r1)).not.toContain('ALREADY COMPLETED');
    await runDurable(base(journal, 'cf-1', { model: capturingModel('c1', ARGS, []), tools, limits, approvals: { c1: true } }) as any);
    expect(state.n).toBe(1); // marker doğdu

    // r2: AYNI iş yeni istek → soru YİNE gelir ve tekrar bağlamı taşır
    const r2 = await runDurable(base(journal, 'cf-2', { model: capturingModel('c2', ARGS, []), tools, limits }) as any);
    expect(r2.interrupts).toHaveLength(1); // her tekrar sorulur
    expect(reasonOf(r2)).toContain('ALREADY COMPLETED');
    expect(reasonOf(r2)).toContain('c1'); // ilk sonucun adresi

    // "bilerek istiyorum" → onay → GERÇEK ikinci iş
    await runDurable(base(journal, 'cf-2', { model: capturingModel('c2', ARGS, []), tools, limits, approvals: { c2: true } }) as any);
    expect(state.n).toBe(2);

    // r3: üçüncü kez → YİNE sorulur, yine bağlamlı
    const r3 = await runDurable(base(journal, 'cf-3', { model: capturingModel('c3', ARGS, []), tools, limits }) as any);
    expect(r3.interrupts).toHaveLength(1);
    expect(reasonOf(r3)).toContain('ALREADY COMPLETED');
  });
});

describe('replay-disclosure — STREAM zarfı (K28 kapanışı)', () => {
  it('stream sonucu lazy zarf taşır: tüketim öncesi boş, tüketim sonrası dolu', async () => {
    const { streamDurable } = await import('../src/run.js');
    // Kendi stream mock'umuz: her koşumda FARKLI toolCallId (gerçek modeller benzersiz üretir —
    // sabit-id'li paylaşımlı mock, identity-bazlı self testine yanlış pozitif veriyordu).
    const mkStreamAgent = (callId: string) => ({
      specificationVersion: 'v4', provider: 'mock', modelId: 'm', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream-only'); },
      doStream: async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        const usage = { inputTokens: { total: 1, noCache: 1 }, outputTokens: { total: 1, text: 1 } };
        const arr = done === 0
          ? [{ type: 'stream-start', warnings: [] }, { type: 'tool-call', toolCallId: callId, toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) }, { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage }]
          : [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage }];
        return { stream: new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } }) };
      },
    });
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = {
      chargeCard: {
        description: 'charge', sideEffect: true, idempotency: 'args' as const, idempotencyWindow: 'thread' as const,
        recover: async () => ({ done: false as const }),
        execute: async () => { state.n += 1; return { charged: 20 }; },
      },
    };
    const consume = async (r: any) => { for await (const _ of r.fullStream) { /* tüket */ } };
    const r1 = await streamDurable({ runId: 'sd-1', journal, threadId: 'th-s', model: mkStreamAgent('call-A'), tools, stopWhen: stepCountIs(4), prompt: 'charge' } as any);
    await consume(r1);
    expect(state.n).toBe(1);
    expect((r1 as any).replayedToolCalls).toBeUndefined(); // taze iş — zarf boş

    const r2 = await streamDurable({ runId: 'sd-2', journal, threadId: 'th-s', model: mkStreamAgent('call-B'), tools, stopWhen: stepCountIs(4), prompt: 'charge' } as any);
    expect((r2 as any).replayedToolCalls).toBeUndefined(); // TÜKETİM ÖNCESİ: lazy — henüz boş
    await consume(r2);
    expect(state.n).toBe(1); // replay, koşmadı
    const env = (r2 as any).replayedToolCalls;
    expect(env).toHaveLength(1); // TÜKETİM SONRASI: dolu
    expect(env[0]).toMatchObject({ toolName: 'chargeCard', origin: 'window' });
  });
});
