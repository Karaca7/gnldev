// TEKRAR MATRİSİ — "gerçekten işe yarıyor mu?" (kullanıcı sorusu: kelimeler aynı değilse ama iş
// aynıysa ne oluyor?). Confirm'lü kritik araçta sorunun HANGİ bilgiyle geldiği pinlenir:
//   birebir aynı argümanlar (prompt farklı olsa da)  → ⚠ Identical (exact marker; kelimeler önemsiz)
//   argüman ANAHTAR SIRASI farklı                    → ⚠ Identical (stableStringify — sıra önemsiz)
//   aynı kimlik, FARKLI YAZIM (case)                 → ⚠ SAME business identity (semantik bakış)
//   aynı kimlik, FARKLI TUTAR                        → ⚠ amounts DIFFER
//   farklı kimlik                                    → generic soru (yanlış alarm YOK)
//   skor tek başına                                  → ASLA ⚠ üretmez (kimlik alanı karar verir)
// Ve iki değişmez: soru KOŞMADAN sorulur (sayaç sabit), onay GERÇEK işi açar / ret açmaz.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Deterministik sahte embedder (semantic-dup.test kalıbı): aynı metin → aynı vektör (kosinüs 1). */
function fakeEmbed() {
  return async (texts: string[]): Promise<number[][]> =>
    texts.map((t) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      const vec = new Array(32).fill(0);
      vec[h % 32] = 1;
      vec[(h >> 5) % 32] += 0.5;
      return vec;
    });
}

function buildTool(state: { n: number }, extra: Record<string, unknown> = {}) {
  return {
    siparis: {
      description: 'sipariş oluştur',
      sideEffect: true,
      confirm: true,
      recover: async () => ({ done: false as const }),
      semanticIdentity: { keys: ['sku'], amountFields: ['amount'], ...extra },
      execute: async (args: unknown) => { state.n += 1; return { ok: true, order: args }; },
    },
  };
}

const LIMITS = {
  sideEffectDuplicates: {
    action: 'suspend' as const,
    scope: 'thread' as const,
    semantic: { embed: fakeEmbed(), embedModelId: 'test-embed' },
  },
};

const model = (callId: string, args: unknown) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('siparis', callId, args) : finalTextResult('tamam'));

const run = (journal: InMemoryJournal, runId: string, prompt: string, callId: string, args: unknown, tools: any, approvals?: Record<string, boolean>) =>
  runDurable({
    runId, journal, prompt, threadId: 'th-m', stopWhen: stepCountIs(4),
    model: model(callId, args), tools, limits: LIMITS, ...(approvals ? { approvals } : {}),
  } as any);

const reasonOf = (r: any): string => r.interrupts[0]?.reason ?? '';

describe('tekrar matrisi — soru her zaman gelir, BİLGİSİ vakaya göre değişir', () => {
  it('tam matris: exact / anahtar-sırası / yazım-farkı / tutar-farkı / farklı-iş / onay / ret', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = buildTool(state);

    // 0) İLK iş: generic soru → onay → koşar (zemin)
    const r0 = await run(journal, 'm-0', 'LAMBA-1 sipariş et', 'c0', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r0)).toContain('explicit confirmation');
    expect(reasonOf(r0)).not.toContain('⚠');
    expect(state.n).toBe(0); // soru KOŞMADAN geldi
    await run(journal, 'm-0', 'LAMBA-1 sipariş et', 'c0', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools, { c0: true });
    expect(state.n).toBe(1);

    // 1) KELİMELER FARKLI, argümanlar birebir aynı → exact ⚠ (prompt'un hiçbir önemi yok)
    const r1 = await run(journal, 'm-1', 'şu lambadan bir tane daha alayım bence', 'c1', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r1)).toContain('Identical work was ALREADY COMPLETED');
    expect(reasonOf(r1)).toContain('c0'); // ilk sonucun adresi
    expect(state.n).toBe(1);

    // 2) ANAHTAR SIRASI farklı → aynı parmak izi (stableStringify) → yine exact ⚠
    const r2 = await run(journal, 'm-2', 'tekrar', 'c2', { amount: 40, qty: 1, sku: 'LAMBA-1' }, tools);
    expect(reasonOf(r2)).toContain('Identical work was ALREADY COMPLETED');
    expect(state.n).toBe(1);

    // 3) YAZIM FARKI: 'lamba-1' (küçük) → hash farklı, exact yakalamaz; SEMANTİK kimlik yakalar
    const r3 = await run(journal, 'm-3', 'lamba-1 den bir tane', 'c3', { sku: 'lamba-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r3)).not.toContain('Identical work'); // exact değil
    expect(reasonOf(r3)).toContain('SAME business identity');
    expect(reasonOf(r3)).toContain('c0'); // ilk işin adresi semantikten de gelir
    expect(state.n).toBe(1);

    // 3b) "bilerek istiyorum" → onay → GERÇEK ikinci iş (yazım farklı olsa da onay açar)
    await run(journal, 'm-3', 'lamba-1 den bir tane', 'c3', { sku: 'lamba-1', qty: 1, amount: 40 }, tools, { c3: true });
    expect(state.n).toBe(2);

    // 4) AYNI KİMLİK, FARKLI TUTAR → 'amounts DIFFER' uyarısı (dikkat çağrısı, dedup iddiası değil)
    const r4 = await run(journal, 'm-4', 'lamba ama 90 liraya', 'c4', { sku: 'LAMBA-1', qty: 1, amount: 90 }, tools);
    expect(reasonOf(r4)).toContain('amounts DIFFER');
    expect(state.n).toBe(2);

    // 5) FARKLI İŞ (başka sku) → generic soru, ⚠ YOK (yanlış alarm üretmiyoruz)
    const r5 = await run(journal, 'm-5', 'bir de masa', 'c5', { sku: 'MASA-7', qty: 1, amount: 200 }, tools);
    expect(reasonOf(r5)).toContain('explicit confirmation');
    expect(reasonOf(r5)).not.toContain('⚠');

    // 6) RET yolu: tekrar sorusuna hayır → koşmaz
    const r6 = await run(journal, 'm-6', 'lamba yine', 'c6', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(reasonOf(r6)).toContain('⚠');
    await run(journal, 'm-6', 'lamba yine', 'c6', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools, { c6: false });
    expect(state.n).toBe(2); // ret = sıfır yeni çalıştırma

    // 7) HER SEFERİNDE sorulur: bir onaydan sonra bile sonraki tekrar yine soru
    const r7 = await run(journal, 'm-7', 'lamba bir daha', 'c7', { sku: 'LAMBA-1', qty: 1, amount: 40 }, tools);
    expect(r7.interrupts).toHaveLength(1);
    expect(reasonOf(r7)).toContain('⚠');
  });

  it('skor TEK BAŞINA asla ⚠ üretmez: canonical aynı olsa da kimlik alanı farklıysa soru GENERIC kalır', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    // describe sabit → her çağrının vektörü AYNI (kosinüs 1.0) — ama kimlik alanı (sku) karar verir.
    const tools = buildTool(state, { describe: () => 'siparis islemi' });
    await run(journal, 's-0', 'x', 'c0', { sku: 'A-1', qty: 1, amount: 10 }, tools);
    await run(journal, 's-0', 'x', 'c0', { sku: 'A-1', qty: 1, amount: 10 }, tools, { c0: true });
    expect(state.n).toBe(1);
    const r = await run(journal, 's-1', 'y', 'c1', { sku: 'B-2', qty: 1, amount: 10 }, tools);
    expect(reasonOf(r)).toContain('explicit confirmation');
    expect(reasonOf(r)).not.toContain('⚠'); // %100 benzer vektör bile kimlik eşleşmeden soruyu süsleyemez
  });

  it("semantik bakış FAIL-OPEN: embedder çökük → soru generic gelir, akış asla kırılmaz", async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const tools = buildTool(state);
    const broken = {
      sideEffectDuplicates: {
        action: 'suspend' as const, scope: 'thread' as const,
        semantic: { embed: async () => { throw new Error('embed down'); }, embedModelId: 'down' },
      },
    };
    const runB = (id: string, cid: string, args: unknown, ap?: Record<string, boolean>) =>
      runDurable({ runId: id, journal, prompt: 'x', threadId: 'th-b', stopWhen: stepCountIs(4), model: model(cid, args), tools, limits: broken, ...(ap ? { approvals: ap } : {}) } as any);
    await runB('b-0', 'c0', { sku: 'K-1', qty: 1, amount: 5 });
    await runB('b-0', 'c0', { sku: 'K-1', qty: 1, amount: 5 }, { c0: true });
    const r = await runB('b-1', 'c1', { sku: 'k-1', qty: 1, amount: 5 }); // yazım farkı, embed ölü
    expect(r.interrupts).toHaveLength(1); // soru yine gelir (confirm) — sadece süssüz
    expect(reasonOf(r)).toContain('explicit confirmation');
    expect(state.n).toBe(1);
  });
});
