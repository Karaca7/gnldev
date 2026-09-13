// TÜRETİLMİŞ EBEVEYNİN ÇOCUĞU, MOTORUN KENDİ SÜZGECİNE TAKILIYORDU.
//
// Dönem devri, fork ya da replay geçirmiş bir koşumun id'si `run1_<dijest>#2` biçimindedir. O koşum
// bir alt ajana devrettiğinde çocuğun id'sini motorun kendisi kuruyor: `nestedAgentRunId` →
// `agent:run1_<dijest>#2:<tcid>`. Ama `assertRunIdSafe`'in `#` yasağı iki dallıydı ve ikisi de bu
// id'yi ıskalıyordu: birinci dal yalnız `run1_` ile BAŞLAYAN id'lere bakıyor (bileşik id `agent:` ile
// başlar), ikinci dal ise "içinde `#` varsa reddet" diyor. Yani motor kendi ürettiği id'yi reddediyordu.
//
// Kullanıcı gözünde bedeli şu: haftalardır çalışan bir ajanın dönemi devredilir, yeni dönem İLK kez
// bir alt ajana devretmeye kalkar ve orada kalır. Kaçış yolu yok — id'yi çağıran seçmiyor.
//
// Düzeltme SÜZGEÇ tarafında. `nestedAgentRunId` SAF kalır ve öyle kalmalı: limits'in `sumSubRuns`'ı ve
// retention'ın purge kaskadı çocuğu gözlemlemez, ebeveynin araç kayıtlarından YENİDEN TÜRETİR. Bu
// dosya hem süzgecin yeni sınırını hem de o iki yeniden-türetmenin devrilmiş bir ebeveynde hâlâ
// tuttuğunu pinliyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, nestedAgentRunId } from '../src/journal.js';
import { assertRunIdSafe } from '../src/run.js';
import { derivedRunId } from '../src/hash.js';
import { rolloverRun } from '../src/rollover.js';
import { purgeRun } from '../src/retention.js';
import { enforceStepLimits } from '../src/limits.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult, toolCallResult, countToolResults } from './mock.js';

/** Şekil olarak motorun basabileceği bir dijest — 32 küçük harf hex. */
const D = 'run1_' + 'ab12'.repeat(8);

describe('süzgeç: gömülü türetilmiş ebeveyn taşıyan bileşik id', () => {
  it('motorun KENDİ kurduğu çocuk id\'lerini kabul eder', () => {
    // Üç önek de aynı şekli kuruyor (agent-tool, registry workflow-as-tool, network).
    expect(() => assertRunIdSafe(`agent:${D}#2:call-x`)).not.toThrow();
    expect(() => assertRunIdSafe(`wf:${D}#2:call-x`)).not.toThrow();
    expect(() => assertRunIdSafe(`net:${D}#2:0`)).not.toThrow();
    // Diğer iki eksen soneki de aynı sınıftan: fork'lanmış ve replay'lenmiş ebeveynler.
    expect(() => assertRunIdSafe(`agent:${D}#fork-1:call-x`)).not.toThrow();
    expect(() => assertRunIdSafe(`agent:${D}#replay-0:call-x`)).not.toThrow();
    // İki kat derin devir: torun, çocuğun id'sini ebeveyn olarak taşır.
    expect(() => assertRunIdSafe(`agent:agent:${D}#2:call-x:call-y`)).not.toThrow();
    // Soneksiz türetilmiş ebeveyn zaten geçiyordu — regresyon çıpası.
    expect(() => assertRunIdSafe(`agent:${D}:call-x`)).not.toThrow();
  });

  it('elle yazılmış `#` YİNE reddedilir — muafiyet şekle bağlı, önek listesine değil', () => {
    expect(() => assertRunIdSafe('benim#işim')).toThrow(/#/);
    expect(() => assertRunIdSafe('order-1#2')).toThrow(/#/);
    // Sahte dijest: `run1_` giyiyor ama şekli tutmuyor → gömülü parça sayılmaz.
    expect(() => assertRunIdSafe('agent:run1_zzz#2:call-x')).toThrow(/#/);
    expect(() => assertRunIdSafe(`agent:${D.slice(0, -1)}#2:call-x`)).toThrow(/#/);
    // Zincir sonek: motor bunu hiç basmaz.
    expect(() => assertRunIdSafe(`agent:${D}#2#3:call-x`)).toThrow(/#/);
    // Yasak sonek yazımları (`#1`, `#0`, sıfır dolgulu) gömülü olarak da geçmez.
    expect(() => assertRunIdSafe(`agent:${D}#1:call-x`)).toThrow(/#/);
    expect(() => assertRunIdSafe(`agent:${D}#fork-0:call-x`)).toThrow(/#/);
    expect(() => assertRunIdSafe(`agent:${D}#replay-01:call-x`)).toThrow(/#/);
    // Türetilmiş parçaya BİTİŞİK çöp: segment sınırı `:` — yarım eşleşme muaf değildir.
    expect(() => assertRunIdSafe(`agent:${D}#2x:call-x`)).toThrow(/#/);
    // `#` bir toolCallId'nin içinde geçemez; bu bugünkü davranış, korunuyor.
    expect(() => assertRunIdSafe(`agent:${D}:call#x`)).toThrow(/#/);
    // Tek başına sahte türetilmiş id hâlâ birinci dalda ölür (mesaj farklı, ret aynı).
    expect(() => assertRunIdSafe('run1_zzz#2')).toThrow(/reserved for/);
  });
});

const ALT_CEVABI = 'alt tamam';

/** Ana ajan bir kez alt ajanı çağırır, sonra bitirir. */
const delegatingModel = (toolCallId: string) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0
      ? toolCallResult('agent_alt', toolCallId, { task: 'bir şey yap' })
      : finalTextResult('devir sonrası bitti'));

function gnlOf(journal: InMemoryJournal, model: unknown) {
  return createGnl({
    journal,
    agents: {
      ana: { model, agents: ['alt'] },
      alt: { model: createMockModel(async () => finalTextResult(ALT_CEVABI)) },
    },
  } as never);
}

/** Bir dönem koşar, devreder, ikinci dönemde alt ajana devreder. Devrilmiş ebeveynin çocuğunu döndürür. */
async function devirSonrasiDelegasyon(journal: InMemoryJournal, tcid: string) {
  const base = derivedRunId('ana', 'resource', 'u-1', 'aylik-mutabakat');
  await gnlOf(journal, createMockModel(async () => finalTextResult('dönem 1 bitti'))).run('ana', {
    runId: base,
    prompt: 'dönem 1',
  } as never);
  const { newRunId, messages } = await rolloverRun(journal, base);
  expect(newRunId, 'devir türetilmiş eksene inmemiş').toBe(`${base}#2`);

  // Devrin belgelenmiş sürdürme biçimi: yeni dönem tohumun İÇERİĞİYLE koşar (rollover.ts,
  // INPUT-SEED CONTRACT). Tohum artık parmak izi de taşıyor, yani başka bir içerik 409 olurdu.
  const res = await gnlOf(journal, delegatingModel(tcid)).run('ana', {
    runId: newRunId,
    messages,
    limits: { maxTokens: 1_000_000 },
  } as never);
  return { base, parent: newRunId, child: nestedAgentRunId(newRunId, tcid), res };
}

describe('devrilmiş ebeveyn uçtan uca devredebilir', () => {
  it('alt koşum GERÇEKTEN koşar ve kendi journal\'ını yazar', async () => {
    const journal = new InMemoryJournal();
    const { parent, child, res } = await devirSonrasiDelegasyon(journal, 'call-devir');

    expect(child).toBe(`${parent}:call-devir`.replace(/^/, 'agent:'));
    // Kırmızıda burası boştu: çocuk hiç doğmuyordu, çünkü kendi id'si reddediliyordu.
    expect(await journal.get(runKeys.input(child)), 'alt koşumun `:input` kaydı yok — hiç doğmamış').toBeDefined();
    expect(await journal.get(runKeys.model(child, 0)), 'alt koşumun model adımı yok').toBeDefined();
    // Ve ebeveyn devri gerçekten tamamlar (araç bir hatayla dönmez).
    expect(res.text).toBe('devir sonrası bitti');
    const toolRec = await journal.get<{ status?: string; output?: any }>(runKeys.tool(parent, 'call-devir'));
    expect(toolRec?.status).toBe('succeeded');
    expect(JSON.stringify(toolRec?.output)).toContain(ALT_CEVABI);
  });

  it('purge kaskadı çocuğu YENİDEN TÜRETEREK bulur', async () => {
    const journal = new InMemoryJournal();
    const { parent, child } = await devirSonrasiDelegasyon(journal, 'call-purge');
    expect(await journal.get(runKeys.model(child, 0))).toBeDefined();

    await purgeRun(journal as never, parent);

    // Kaskad `nestedAgentRunId(parent, tcid)` ile yeniden türetiyor — `#`'li ebeveynde de tutmalı,
    // yoksa alt ajanın çıktısı (PII taşıyabilir) silme talebinden sonra yetim kalır.
    expect(await journal.get(runKeys.model(child, 0)), 'alt koşumun kaydı purge sonrası yaşıyor').toBeUndefined();
    expect(await journal.get(runKeys.input(child))).toBeUndefined();
  });

  it('sumSubRuns yeniden-türetmesi çocuğun jetonlarını tavana katar', async () => {
    const journal = new InMemoryJournal();
    const { parent, child } = await devirSonrasiDelegasyon(journal, 'call-tavan');

    // Sayaçlar `incrBy`/`getCounters` alanında yaşıyor (bkz. limits.ts readCounters), düz `get`'te değil.
    const tokensOf = async (id: string) =>
      (await (journal as any).getCounters(runKeys.proc(id, '__gnl_limits_counters')))?.totalTokens as number | undefined;
    const kidTokens = await tokensOf(child);
    const parentTokens = await tokensOf(parent);
    expect(kidTokens, 'alt koşum hiç jeton saymamış').toBeGreaterThan(0);
    const toplam = (parentTokens ?? 0) + (kidTokens ?? 0);

    // Tavan toplamın bir altındaysa patlar — yani çocuk gerçekten toplanıyor.
    await expect(enforceStepLimits(journal as never, parent, { maxTokens: toplam - 1 })).rejects.toThrow(/maxTokens/);
    // Tam toplamda patlamaz: fazladan bir şey sayılmıyor.
    await expect(enforceStepLimits(journal as never, parent, { maxTokens: toplam })).resolves.toBeUndefined();
  });
});
