// FAZ-6 — semantik mükerrer-aday kapısı. Pinlenenler:
// 1) çift opt-in + config çelişkilerinde THROW (action/scope/embedModelId/keys[]/noApprovals)
// 2) uçtan uca akış: başarı → sem kayıt; parafraz-benzeri tekrar → suspend (firstToolCallId ile);
//    onay → çalışır + "farklı iş" tombstone'u; aynı çift bir daha SORULMAZ
// 3) skor tek başına ASLA suspend tetiklemez (identity mismatch → sadece telemetri, çıktı bayt-aynı)
// 4) negasyon kapıları: cross-tool (toolName filtresi) + intra-tool (discriminatorFields)
// 5) miktar kapısı: identity eşit + amount farklı → "amounts differ" mesajlı suspend
// 6) fail-open: embedder çökük → kayıt vektörsüz yazılır, recall sessiz geçer, iş asla bloklanmaz;
//    3 ardışık hatada BİR outage incident'ı
// 7) damga disiplini: farklı embedModelId'li kayıt karşılaştırılmaz
// 8) yaşam döngüsü: purgeThread sem+semtomb ailelerini süpürür; farklı thread aday değildir
// 9) replay'de embed tekrar ödenmez; threadId yoksa loud warn + katman devre dışı
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { purgeThread } from '../src/retention.js';
import { durableTools } from '../src/durable-tool.js';
import { readIncidents } from '../src/incidents.js';
import { semKey, semTombKey } from '../src/semantic-dup.js';
import type { SemDupRecord } from '../src/semantic-dup.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Deterministik sahte embedder: metin → tek-sıcak (one-hot benzeri) vektör. Aynı metin = kosinüs
 *  1.0, farklı metin = 0.0 — testler benzerliği identity-eşit vakalarda AYNI kanonik cümle üzerinden
 *  Kurar (describe() sabitiyle de "benzer ama kimliksiz" vakası üretilir). */
function fakeEmbed(counter?: { n: number }) {
  return async (texts: string[]): Promise<number[][]> => {
    if (counter) counter.n += texts.length;
    return texts.map((t) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      const vec = new Array(32).fill(0);
      vec[h % 32] = 1;
      vec[(h >> 5) % 32] += 0.5;
      return vec;
    });
  };
}

const semLimits = (embed: (t: string[]) => Promise<number[][]>, modelId: string, extra: Record<string, unknown> = {}) => ({
  sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: modelId, ...extra } },
});

const model = (toolName: string, callId: string, args: unknown) => () =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult(toolName, callId, args) : finalTextResult('done'));

const base = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown>) => ({
  runId, journal, stopWhen: stepCountIs(6), prompt: 'x', ...extra,
});

describe('FAZ-6 config kapıları', () => {
  const dummyEmbed = fakeEmbed();
  it("semantic + action!=='suspend' → run başlamadan THROW", async () => {
    const limits = { sideEffectDuplicates: { action: 'warn' as const, scope: 'thread' as const, semantic: { embed: dummyEmbed, embedModelId: 'm' } } };
    const tools = { t: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    await expect(
      runDurable(base(new InMemoryJournal(), 'c1', { model: model('t', 'x', {})(), tools, threadId: 'th', limits }) as any),
    ).rejects.toThrow(/action: 'suspend'/);
  });
  it('embedModelId eksik → THROW; keys boş → THROW; noApprovals → THROW', () => {
    const journal = new InMemoryJournal();
    const mk = (limits: any, tools: any, noApprovals = false) => () =>
      durableTools(tools, { journal, runId: 'c2', limits, ...(noApprovals ? { noApprovals: true } : {}) } as any);
    const okTools = { t: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => 1 } };
    expect(mk({ sideEffectDuplicates: { action: 'suspend', scope: 'thread', semantic: { embed: dummyEmbed } } }, okTools)).toThrow(/embedModelId/);
    expect(mk(semLimits(dummyEmbed, 'm'), { t: { sideEffect: true, semanticIdentity: { keys: [] }, execute: async () => 1 } })).toThrow(/EMPTY keys/);
    expect(mk(semLimits(dummyEmbed, 'm'), okTools, true)).toThrow(/no approvals channel/i);
  });
});

describe('FAZ-6 uçtan uca akış', () => {
  it('başarı → kayıt; benzer tekrar → suspend; onay → çalışır + tombstone; çift bir daha sorulmaz', async () => {
    const journal = new InMemoryJournal();
    const embeds = { n: 0 };
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(embeds), 'e2e-model');
    const tools = {
      createProduct: {
        sideEffect: true,
        semanticIdentity: { keys: ['sku'] },
        execute: async ({ sku }: any) => { counter.n++; return { created: sku }; },
      },
    };
    // r1: "ABC ürününü oluştur"
    await runDurable(base(journal, 'r1', { model: model('createProduct', 'call-1', { sku: 'ABC', note: 'ilk' })(), tools, threadId: 'th-A', limits }) as any);
    expect(counter.n).toBe(1);
    const semKeys = await journal.listKeys('xthr:th-A:sem-');
    expect(semKeys).toHaveLength(1);
    const rec = await journal.get<SemDupRecord>(semKeys[0]!);
    expect(rec).toMatchObject({ v: 1, toolName: 'createProduct', embedModelId: 'e2e-model', identity: { sku: 'abc' }, firstToolCallId: 'call-1' });
    expect(rec!.vecB64).toBeTruthy();
    expect(rec!.canonical).toBe('createProduct: abc');
    expect(rec!.canonical).not.toContain('ilk'); // beyan edilmeyen alan embedder'a SIZMAZ

    // r2: ertesi gün, farklı sözcüklerle aynı iş (hash farklı, kimlik aynı)
    const r2model = model('createProduct', 'call-2', { sku: ' abc ', note: 'unutmuşum, tekrar' }); // trim+case-fold normalize kanıtı
    await runDurable(base(journal, 'r2', { model: r2model(), tools, threadId: 'th-A', limits }) as any);
    expect(counter.n).toBe(1); // ATEŞLENMEDİ — soru soruldu
    const susRec = await journal.get<any>('r2:tool:call-2');
    expect(susRec.status).toBe('suspended');
    expect(susRec.output.__gnl_suspend.reason).toContain('call-1'); // ilk sonucun adresi soruda
    expect(susRec.output.__gnl_suspend.reason).toContain('% match');
    const incidents = await readIncidents(journal, 'r2');
    expect(incidents.some((i) => i.source === 'semantic-guard' && i.action === 'suspend')).toBe(true);

    // onay: insan "yine de yap" dedi → çalışır + 'farklı iş' tombstone'u doğar
    await runDurable(base(journal, 'r2', { model: r2model(), tools, threadId: 'th-A', limits, approvals: { 'call-2': true } }) as any);
    expect(counter.n).toBe(2);
    const tombs = await journal.listKeys('xthr:th-A:semtomb-');
    expect(tombs).toHaveLength(1);

    // r3: r2 ile AYNI argümanlar → artık KATMAN-3'ün exact-hash marker'ı yakalar (deterministik >
    // olasılıksal: semantik kapıya hiç inilmez, soru katman-3'ün sorusudur). Katmanlama pini:
    await runDurable(base(journal, 'r3', { model: model('createProduct', 'call-3', { sku: ' abc ', note: 'unutmuşum, tekrar' })(), tools, threadId: 'th-A', limits }) as any);
    expect(counter.n).toBe(2);
    const r3rec = await journal.get<any>('r3:tool:call-3');
    expect(r3rec.status).toBe('suspended');
    expect(r3rec.output.__gnl_suspend.reason).toContain('identical arguments'); // exact katmanın sesi, semantiğin değil

    // farklı thread aday DEĞİL
    await runDurable(base(journal, 'r4', { model: model('createProduct', 'call-4', { sku: 'ABC', note: 'başka konuşma' })(), tools, threadId: 'th-B', limits }) as any);
    expect(counter.n).toBe(3);
  });

  it("tombstone: 'farklı iş' hükmü verilen çift, exact-marker yokken bile bir daha SORULMAZ", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'tomb-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const argsA = { sku: 'T-1', note: 'ilk' };
    const argsB = { sku: 'T-1', note: 'ikinci' }; // farklı hash, aynı kimlik → normalde suspend adayı
    await runDurable(base(journal, 't1', { model: model('createProduct', 'c1', argsA)(), tools, threadId: 'th-T', limits }) as any);
    // İnsan bu çifti daha önce 'farklı iş' saymış gibi tombstone'u elle koy (onay yolunun ürettiği anahtar):
    const { argsHash } = await import('../src/hash.js');
    await journal.put(semTombKey('th-T', 'createProduct', argsHash(argsA), argsHash(argsB)), { at: 1 });
    await runDurable(base(journal, 't2', { model: model('createProduct', 'c2', argsB)(), tools, threadId: 'th-T', limits }) as any);
    expect(counter.n).toBe(2); // soru sorulmadı — çift hükme bağlanmıştı
    // Tombstone'suz üçüncü bir varyant hâlâ sorulur (tombstone çifte özgü, battaniye değil):
    await runDurable(base(journal, 't3', { model: model('createProduct', 'c3', { sku: 'T-1', note: 'üçüncü' })(), tools, threadId: 'th-T', limits }) as any);
    expect(counter.n).toBe(2);
    expect((await journal.get<any>('t3:tool:c3')).status).toBe('suspended');
  });

  it('replay aynı runId → semantik kapıya hiç inilmez, embed tekrar ödenmez', async () => {
    const journal = new InMemoryJournal();
    const embeds = { n: 0 };
    const limits = semLimits(fakeEmbed(embeds), 'replay-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    await runDurable(base(journal, 'rp1', { model: model('createProduct', 'c1', { sku: 'X' })(), tools, threadId: 'th-R', limits }) as any);
    const after = embeds.n;
    await runDurable(base(journal, 'rp1', { model: model('createProduct', 'c1', { sku: 'X' })(), tools, threadId: 'th-R', limits }) as any);
    expect(embeds.n).toBe(after); // fast-path replay — embedder'a inilmedi
  });
});

describe('FAZ-6 karar kapıları (skor asla tek başına karar vermez)', () => {
  it('identity uyuşmazsa: suspend YOK, çıktı bayt-aynı, sadece telemetri (modele sıfır bildirim)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'id-model');
    const tools = {
      createProduct: {
        sideEffect: true,
        // describe SABİT → her çağrının kanonik cümlesi aynı → kosinüs 1.0 (yüksek benzerlik) —
        // ama kimlik alanı FARKLI: skor tek başına suspend tetikleyemez.
        semanticIdentity: { keys: ['sku'], describe: () => 'create a product' },
        execute: async ({ sku }: any) => { counter.n++; return { created: sku }; },
      },
    };
    await runDurable(base(journal, 's1', { model: model('createProduct', 'c1', { sku: 'AAA' })(), tools, threadId: 'th-S', limits }) as any);
    const r2 = await runDurable(base(journal, 's2', { model: model('createProduct', 'c2', { sku: 'BBB' })(), tools, threadId: 'th-S', limits }) as any);
    expect(counter.n).toBe(2); // çalıştı — benzerlik %100 olsa bile kimlik farklı
    expect(JSON.stringify(r2.steps)).toContain('"created":"BBB"'); // çıktı normal, ekstra alan yok
    expect(JSON.stringify(r2.steps)).not.toContain('semantic'); // modele sıfır bildirim pini
    const incidents = await readIncidents(journal, 's2');
    expect(incidents.some((i) => i.source === 'semantic-guard' && i.action === 'warn')).toBe(true); // kalibrasyon telemetrisi
  });

  it('cross-tool negasyon: farklı araç asla aday değil (deleteProduct, createProduct kaydını görmez)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'x-model');
    const tools = {
      createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 'c' }; } },
      deleteProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 'd' }; } },
    };
    await runDurable(base(journal, 'x1', { model: model('createProduct', 'c1', { sku: 'ABC' })(), tools, threadId: 'th-X', limits }) as any);
    await runDurable(base(journal, 'x2', { model: model('deleteProduct', 'c2', { sku: 'ABC' })(), tools, threadId: 'th-X', limits }) as any);
    expect(counter.n).toBe(2); // silme, oluşturmanın mükerrer adayı DEĞİL
  });

  it('intra-tool negasyon: discriminator farklıysa aday düşer; aynıysa suspend', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'd-model');
    const tools = {
      refund: {
        sideEffect: true,
        semanticIdentity: { keys: ['orderId'], discriminatorFields: ['cancel'] },
        execute: async () => { counter.n++; return { ok: 1 }; },
      },
    };
    await runDurable(base(journal, 'd1', { model: model('refund', 'c1', { orderId: 'O-1', cancel: false })(), tools, threadId: 'th-D', limits }) as any);
    // cancel:true = anlamca ZIT iş → çalışmalı
    await runDurable(base(journal, 'd2', { model: model('refund', 'c2', { orderId: 'O-1', cancel: true, note: 'z' })(), tools, threadId: 'th-D', limits }) as any);
    expect(counter.n).toBe(2);
    // cancel:false + aynı orderId (farklı hash) = gerçek mükerrer adayı → suspend
    await runDurable(base(journal, 'd3', { model: model('refund', 'c3', { orderId: 'O-1', cancel: false, note: 'w' })(), tools, threadId: 'th-D', limits }) as any);
    expect(counter.n).toBe(2);
    expect((await journal.get<any>('d3:tool:c3')).status).toBe('suspended');
  });

  it('miktar kapısı: kimlik eşit + tutar farklı → "amounts differ" mesajlı suspend', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'a-model');
    const tools = {
      charge: {
        sideEffect: true,
        semanticIdentity: { keys: ['orderId'], amountFields: ['amount'] },
        execute: async () => { counter.n++; return { ok: 1 }; },
      },
    };
    await runDurable(base(journal, 'a1', { model: model('charge', 'c1', { orderId: 'O-9', amount: 99.9 })(), tools, threadId: 'th-M', limits }) as any);
    await runDurable(base(journal, 'a2', { model: model('charge', 'c2', { orderId: 'O-9', amount: 9990 })(), tools, threadId: 'th-M', limits }) as any);
    expect(counter.n).toBe(1);
    const rec = await journal.get<any>('a2:tool:c2');
    expect(rec.status).toBe('suspended');
    expect(rec.output.__gnl_suspend.reason).toContain('amounts differ');
  });
});

describe('FAZ-6 fail-open + damga + yaşam döngüsü', () => {
  it('embedder çökük: kayıt vektörsüz yazılır, iş asla bloklanmaz, 3. ardışık hatada outage incident', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const brokenEmbed = async () => { throw new Error('embedder down'); };
    const limits = semLimits(brokenEmbed as any, 'down-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'f1', { model: model('createProduct', 'c1', { sku: 'A' })(), tools, threadId: 'th-F', limits }) as any);
    await runDurable(base(journal, 'f2', { model: model('createProduct', 'c2', { sku: 'B' })(), tools, threadId: 'th-F', limits }) as any);
    await runDurable(base(journal, 'f3', { model: model('createProduct', 'c3', { sku: 'C' })(), tools, threadId: 'th-F', limits }) as any);
    expect(counter.n).toBe(3); // hiçbir iş bloklanmadı
    const rec = await journal.get<SemDupRecord>(semKey('th-F', 'createProduct', (await journal.listKeys('xthr:th-F:sem-'))[0]!.split('-').pop()!));
    // kayıtlar var ama vektörsüz:
    const keys = await journal.listKeys('xthr:th-F:sem-');
    expect(keys.length).toBe(3);
    for (const k of keys) expect((await journal.get<SemDupRecord>(k))!.vecB64).toBeUndefined();
    // 3. ardışık hata → bir outage incident'ı (f3'ün run'ında)
    const inc3 = await readIncidents(journal, 'f3');
    expect(inc3.some((i) => i.source === 'semantic-guard' && String(i.message).includes('failed repeatedly'))).toBe(true);
  });

  it('farklı embedModelId damgalı kayıt asla karşılaştırılmaz', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'model-B');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'm1', { model: model('createProduct', 'c1', { sku: 'S' })(), tools, threadId: 'th-V', limits }) as any);
    // kaydı 'model-A' damgasına boz — model değişmiş gibi
    const k = (await journal.listKeys('xthr:th-V:sem-'))[0]!;
    const rec = await journal.get<SemDupRecord>(k);
    await journal.put(k, { ...rec, embedModelId: 'model-A' });
    await runDurable(base(journal, 'm2', { model: model('createProduct', 'c2', { sku: 'S', note: 'y' })(), tools, threadId: 'th-V', limits }) as any);
    expect(counter.n).toBe(2); // eski-damgalı kayıt dışlandı → soru sorulmadı, iş koştu
  });

  it('purgeThread sem + semtomb ailelerini tek süpürmede götürür', async () => {
    const journal = new InMemoryJournal();
    await journal.put(semKey('th-P', 't', 'h1'), { v: 1 });
    await journal.put(semTombKey('th-P', 't', 'h1', 'h2'), { at: 1 });
    await purgeThread(journal, 'th-P');
    expect(await journal.listKeys('xthr:th-P:')).toEqual([]);
  });

  it('threadId yoksa: loud warn, katman devre dışı, iş normal koşar, xthr temiz', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'nt-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(journal, 'nt1', { model: model('createProduct', 'c1', { sku: 'Q' })(), tools, limits }) as any);
      expect(counter.n).toBe(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('semantic guard'))).toBe(true);
      expect(await journal.listKeys('xthr:')).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

// FAZ-6 denetçi bulguları — K18 pini, frozen-limits round-trip'i, eşzamanlı parafraz ikizi ve iki
// fallback dalı pinlendi.
import { resumeRun } from '../src/run.js';

describe('FAZ-6 denetçi düzeltmeleri', () => {
  it("K18: failed kayıt semantik-suspend ile EZİLMEZ — reclaim merdiveni sahipliğini korur", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    let explode = true;
    const limits = semLimits(fakeEmbed(), 'k18-model');
    const tools = {
      charge: {
        sideEffect: true,
        semanticIdentity: { keys: ['orderId'] },
        execute: async () => { counter.n++; if (explode) throw new Error('timeout — effect uncertain'); return { ok: 1 }; },
      },
    };
    // Geçmişte benzer başarı VAR (semantik aday üretecek):
    await runDurable(base(journal, 'k1', { model: model('charge', 'c1', { orderId: 'O-7', note: 'ilk' })(), tools, threadId: 'th-K', limits }) as any).catch(() => {});
    expect(counter.n).toBe(1); // ilk deneme ateşledi ve çöktü → kayıt 'failed'
    expect((await journal.get<any>('k1:tool:c1')).status).toBe('failed');
    explode = false;
    // Onaysız resume: eski kod semantik aday bulup 'failed'ı 'suspended' ile ezerdi ("benzer iş,
    // çalıştırayım mı?" — bu denemenin ZATEN koşmuş olabileceğini gizleyerek). Şimdi: kayıt duruyor,
    // reclaim merdiveni cevap veriyor (side-effect + onaysız → blocked), etki yeniden ATEŞLENMEZ.
    await runDurable(base(journal, 'k1', { model: model('charge', 'c1', { orderId: 'O-7', note: 'ilk' })(), tools, threadId: 'th-K', limits }) as any).catch(() => {});
    const rec = await journal.get<any>('k1:tool:c1');
    expect(rec.status).toBe('failed'); // ezilmedi
    expect(counter.n).toBe(1); // yeniden ateşlenmedi
  });

  it('frozen-limits round-trip: resumeRun (limits verilmeden) THROW ETMEZ, semantik inaktif + iş koşar', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'rt-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'rr1', { model: model('createProduct', 'c1', { sku: 'R-1' })(), tools, threadId: 'th-RT', limits }) as any);
    // resume: limits VERİLMEZ → journal'daki soyulmuş (embedStripped) kopya kullanılır. Eski kod
    // validateSemanticConfig'te patlıyordu — semantik-aktif HER run'ın resume'u ölüydü.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(resumeRun('rr1', { journal, model: model('createProduct', 'c1', { sku: 'R-1' })(), tools } as any)).resolves.toBeTruthy();
      expect(counter.n).toBe(1); // replay — yeniden ateşleme yok
    } finally { warn.mockRestore(); }
  });

  it('semantik suspend → resumeRun(approvals) uçtan uca: onay koşar + tombstone doğar', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'ap-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'ap1', { model: model('createProduct', 'c1', { sku: 'A-1', note: 'ilk' })(), tools, threadId: 'th-AP', limits }) as any);
    await runDurable(base(journal, 'ap2', { model: model('createProduct', 'c2', { sku: 'A-1', note: 'tekrar' })(), tools, threadId: 'th-AP', limits }) as any);
    expect(counter.n).toBe(1); // suspend
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // Gerçek onay yolu: resumeRun, limits'i journal'dan (soyulmuş) kurtarır — yine de onay akmalı.
      await resumeRun('ap2', { journal, model: model('createProduct', 'c2', { sku: 'A-1', note: 'tekrar' })(), tools, approvals: { 'c2': true } } as any);
    } finally { warn.mockRestore(); }
    expect(counter.n).toBe(2); // onaylanan iş koştu
    expect(await journal.listKeys('xthr:th-AP:semtomb-')).toHaveLength(1); // hüküm tombstone'landı
  });

  it('eşzamanlı parafraz ikizi (dokümante TOCTOU): ikisi de koşar, iki kayıt, suspend yok', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'tw-model');
    const tools = {
      createProduct: {
        sideEffect: true,
        semanticIdentity: { keys: ['sku'] },
        execute: async () => { counter.n++; await new Promise((r) => setTimeout(r, 15)); return { ok: 1 }; },
      },
    };
    await Promise.all([
      runDurable(base(journal, 'tp1', { model: model('createProduct', 'c1', { sku: 'TW', note: 'a' })(), tools, threadId: 'th-TW', limits }) as any),
      runDurable(base(journal, 'tp2', { model: model('createProduct', 'c2', { sku: 'TW', note: 'b' })(), tools, threadId: 'th-TW', limits }) as any),
    ]);
    expect(counter.n).toBe(2); // pencere gerçek: iki farklı-hash ikiz recall'da birbirini göremez
    expect((await journal.listKeys('xthr:th-TW:sem-')).length).toBe(2);
    // Katmanın vaadi ZAMANA YAYILMIŞ mükerrerlik; eşzamanlılık exact-hash/lock katmanlarının işi.
  });

  it("listKeys'siz journal: loud warn benzeri devre dışı kalış, iş normal koşar", async () => {
    const m = new Map<string, unknown>();
    const journal: any = {
      async get(k: string) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
      async put(k: string, v: unknown) { m.set(k, structuredClone(v)); },
      async putIfAbsent(k: string, v: unknown) { if (m.has(k)) return false; m.set(k, structuredClone(v)); return true; },
    };
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'nl-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(journal, 'nl1', { model: model('createProduct', 'c1', { sku: 'N', note: 'a' })(), tools, threadId: 'th-NL', limits }) as any);
      await runDurable(base(journal, 'nl2', { model: model('createProduct', 'c2', { sku: 'N', note: 'b' })(), tools, threadId: 'th-NL', limits }) as any);
      expect(counter.n).toBe(2); // recall taraması devre dışı — iş asla bloklanmadı
      expect(warn.mock.calls.some((c) => String(c[0]).includes('listKeys'))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('ttlMs: penceresi geçmiş sem kaydı artık aday değildir (karar storage saatiyle)', async () => {
    const base2 = new InMemoryJournal();
    const clock = { t: 5_000_000 };
    const journal: any = new Proxy(base2, {
      get: (t, p) => (p === 'now' ? async () => clock.t : (t as any)[p] instanceof Function ? (t as any)[p].bind(t) : (t as any)[p]),
    });
    const counter = { n: 0 };
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, ttlMs: 1_000, semantic: { embed: fakeEmbed(), embedModelId: 'ttl-model' } } };
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'tl1', { model: model('createProduct', 'c1', { sku: 'T', note: 'a' })(), tools, threadId: 'th-TL', limits }) as any);
    clock.t += 2_000; // pencere geçti (exact marker da aynı ttl ile yaşlanır)
    await runDurable(base(journal, 'tl2', { model: model('createProduct', 'c2', { sku: 'T', note: 'b' })(), tools, threadId: 'th-TL', limits }) as any);
    expect(counter.n).toBe(2); // yaşlanmış kayıt soru üretmedi
  });
});
