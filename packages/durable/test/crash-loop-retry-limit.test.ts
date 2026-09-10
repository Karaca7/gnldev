// ÇÖKME DÖNGÜSÜNÜN DE BİR TAVANI VAR.
//
// İki merdiven aynı yere çıkıyor ama biri korkuluksuzdu. `failed` kaydı `attempts` sayıyor ve
// `maxRetries`'e varınca kalıcı olarak duruyor. Bayat `running` kaydı — yani "çalıştı ama sonucu
// yazamadan öldü" — hiçbir şey saymıyordu: her devralma taze bir `{status:'running', startedAt}`
// damgalıyor, sayaç sıfırlanıyordu. Sonuç: kilitlenmiş bir çalıştırıcı ne kadar tur atarsa aracı o
// kadar kez çalıştırıyor.
//
// Bu FARK ETMESİ zor olan cinsten, çünkü hata mesajı yok. Araç düşmüyor, patlamıyor; sadece her
// turda bir kere daha koşuyor. Yan etkili araçta H7 kapısı zaten durduruyordu (onay yoksa devralma
// yok) — ama `idempotent: true` diyen araçta kapı bilerek açık: "tekrarı zararsız" beyanı,
// "sınırsız tekrarı zararsız" demek değil. Sağlayıcı tarafında hız sınırı, kota ve ücret var.
//
// Ölçüm şöyle kuruluyor: execute HİÇ çözülmüyor ve çağrı sahipsiz bırakılıyor — bir işlemin
// tool'un ortasında ölmesinin birebir izi. Geriye bayat bir `running` kalıyor, bir sonraki tur onu
// devralıyor.
import { describe, it, expect } from 'vitest';
import { durableTool } from '../src/durable-tool.js';
import { InMemoryStorage, RetryLimitExceededError } from '../src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import type { DurableCtx, ToolJournalRecord } from '../src/journal.js';

const KEY = 'call-1';

/** Bir tur: aracı çağır, execute'un ortasında çalıştırıcıyı terk et (çöküş). */
function crashOnce(journal: any, runId: string, tool: any, ctx?: Partial<DurableCtx>) {
  const c = { journal, runId, claimTtlMs: 1, ...ctx } as DurableCtx;
  // Bilerek await EDİLMİYOR: çağrı askıda kalır, kayıt 'running' olarak journal'da durur.
  void durableTool(tool, c, 'senkronEt').execute!({ n: 1 }, { toolCallId: KEY }).catch(() => {});
  return new Promise((r) => setTimeout(r, 12)); // claim yazımı insin + ttl(1ms) geçsin
}

function hangingTool(extra: Record<string, unknown>) {
  let started = 0;
  return {
    tool: { ...extra, execute: async () => { started++; return new Promise(() => {}); } } as any,
    started: () => started,
  };
}

describe('bayat running merdiveninin tavanı', () => {
  it('idempotent araç sınırsız yeniden koşmaz — maxRetries burada da geçerli', async () => {
    const journal = new InMemoryStorage().runs;
    const { tool, started } = hangingTool({ idempotent: true, sideEffect: false });

    for (let i = 0; i < 6; i++) await crashOnce(journal, 'cl-1', tool);

    // maxRetries varsayılanı 3. Bir çöküş döngüsü 6 tur attı; araç TAM 3 kez koşmalı.
    // Alt sınır da iddia ediliyor bilerek: bellek-içi kurulum deterministik, yani "en fazla 3"
    // yazmak zincir HİÇ koşmasa da yeşil kalan bir iddiaydı — tavanı ölçerken tabanı düşürüyordu.
    expect(started(), 'her çöküş turu aracı bir kez daha koşturdu — sayaç yok').toBe(3);
  });

  it('tavana varınca SUSMAZ — RetryLimitExceededError ile söyler', async () => {
    const journal = new InMemoryStorage().runs;
    const { tool } = hangingTool({ idempotent: true, sideEffect: false });
    for (let i = 0; i < 4; i++) await crashOnce(journal, 'cl-2', tool);

    // Tavanın üstünde yapılan yeni bir çağrı sessizce hiçbir şey yapmamalı; ne olduğunu söylemeli.
    const ctx = { journal, runId: 'cl-2', claimTtlMs: 1 } as DurableCtx;
    await expect(durableTool(tool, ctx, 'senkronEt').execute!({ n: 1 }, { toolCallId: KEY }))
      .rejects.toBeInstanceOf(RetryLimitExceededError);
  });

  it('sayaç kayıtta GÖRÜNÜR — çöküş turları journal’dan okunabilir', async () => {
    // Teşhis edilebilirlik: "kaç kere çöktü" sorusunun cevabı kaydın içinde olmalı, yoksa tavan
    // vurduğunda kimse nedenini bulamaz.
    const journal = new InMemoryStorage().runs;
    const { tool } = hangingTool({ idempotent: true, sideEffect: false });
    await crashOnce(journal, 'cl-3', tool);
    await crashOnce(journal, 'cl-3', tool);
    const rec = await journal.get<ToolJournalRecord>('cl-3:tool:' + KEY);
    expect(rec?.status).toBe('running');
    expect((rec as { attempts?: number }).attempts).toBe(2);
  });

  it('çöküşten sonraki HATA aynı sayacı sürdürür — merdiven sıfırlanmaz', async () => {
    // Önce çökme, sonra düzgün bir throw: ikisi ayrı sayaç tutarsa tavan hiç dolmaz.
    const journal = new InMemoryStorage().runs;
    const { tool } = hangingTool({ idempotent: true, sideEffect: false });
    await crashOnce(journal, 'cl-4', tool);
    await crashOnce(journal, 'cl-4', tool); // running.attempts = 2

    const boom = { idempotent: true, sideEffect: false, execute: async () => { throw new Error('patladı'); } } as any;
    const ctx = { journal, runId: 'cl-4', claimTtlMs: 1 } as DurableCtx;
    await expect(durableTool(boom, ctx, 'senkronEt').execute!({ n: 1 }, { toolCallId: KEY })).rejects.toThrow('patladı');

    const rec = await journal.get<ToolJournalRecord>('cl-4:tool:' + KEY);
    expect(rec?.status).toBe('failed');
    expect((rec as { attempts?: number }).attempts, 'çöküş turları unutuldu, sayaç 1’e döndü').toBe(3);
  });

  it('DAR YARIŞ: devralma damgası ile catch AYNI sayıyı görür — sayaç GERİ SARMAZ', async () => {
    // Merdivenin kararı bir okumaya, devralma damgası BAŞKA (taze) bir okumaya dayanıyor. Aradaki
    // pencerede ikinci bir işçi devralıp çökerse iki okuma ayrışır: damga taze sayıdan devam eder,
    // catch ise bayat sayıdan. Ölçülen sonuç sayacın İLERİ değil GERİ gitmesi — yani tavan
    // dolmuyor ve çöküş döngüsü tam da korkuluğun tutması gereken yerde serbest kalıyor.
    const journal = new InMemoryJournal();
    const key = 'm1:tool:' + KEY;
    const failed = (n: number, why: string) => ({ status: 'failed', error: why, attempts: n, sideEffect: false, toolName: 'senkronEt' });
    await journal.put(key, failed(1, 'A turu'));

    // B'nin devralıp çökmesi, A'nın İKİ okuması arasına yerleştiriliyor: birinci okuma (merdivenin
    // kararı) 1 görür, ikinci okuma (CAS'in taze operandı) 2 görür.
    const realGet = journal.get.bind(journal);
    let reads = 0;
    (journal as unknown as { get: typeof realGet }).get = async (k: string) => {
      if (k !== key) return realGet(k);
      if (++reads === 2) await journal.put(key, failed(2, 'B çöktü'));
      return realGet(k);
    };

    const boom = { idempotent: true, sideEffect: false, execute: async () => { throw new Error('patladı'); } } as any;
    const ctx = { journal, runId: 'm1', claimTtlMs: 1 } as unknown as DurableCtx;
    await expect(durableTool(boom, ctx, 'senkronEt').execute!({ n: 1 }, { toolCallId: KEY })).rejects.toThrow('patladı');

    const rec = await realGet<ToolJournalRecord>(key);
    expect((rec as { attempts?: number }).attempts, 'catch bayat okumadan saydı — devralma 3 damgaladı, hata 2 yazdı').toBe(3);
  });

  it('TEK çöküş hâlâ devralınıyor — tavan normal kurtarmayı engellemiyor', async () => {
    const journal = new InMemoryStorage().runs;
    let ran = 0;
    const ok = { idempotent: true, sideEffect: false, execute: async () => { ran++; return { ok: true }; } } as any;
    await journal.put('cl-5:tool:' + KEY, { status: 'running', startedAt: Date.now() - 120_000, toolName: 'senkronEt' });
    const ctx = { journal, runId: 'cl-5' } as DurableCtx;
    await durableTool(ok, ctx, 'senkronEt').execute!({ n: 1 }, { toolCallId: KEY });
    expect(ran).toBe(1);
  });
});
