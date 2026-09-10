// KİŞİ SİLME, KİŞİNİN YAPTIKLARINA DA ULAŞIR.
//
// `purgeResource` üç öneki siliyordu: `xid:res:`, `lesson:res:`, `suggstats:lesson:res:`. Üçünün de
// ANAHTARI kişinin adını taşıyor, yani bir önek süpürmesi onları bulur. Ama kişinin YAPTIĞI her şey
// KOŞUMLARININ altında yaşıyor — askıdaki tool kaydı ve ham `args`, donmuş `:input` (prompt +
// resourceId), onay kararları, override izi, incident'lar. Bu anahtarların hiçbiri resourceId'yi
// anmıyor, dolayısıyla hiçbir önek onlara ulaşmıyordu: silme talebinden sonra kişinin siparişleri,
// istemleri ve insan cevapları journal'da kalıyordu.
//
// Bulma aracı zaten vardı — `listRunsPaged({ resourceId })` — ve tam bu sweep'in ihtiyacı olan
// `:input` alanını okuyor. Yani boşluk "yapamıyoruz" değil, "kimse bağlamamış"tı.
//
// DOĞUM YOLLARI BU YÜZDEN ÖNEMLİ: sahibini hiç kaydetmemiş bir koşum (delegasyon, ağ, iş akışı,
// batch, rollover — hepsi bu turda düzeltildi) bu sayımda GÖRÜNMEZ, yani silme sessizce yarım kalır.
// Yarısını atlayan bir silme, reddeden bir silmeden kötüdür: kimse "gitti" denen şeyi aramaz.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { purgeResource } from '../src/retention.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

const go = (journal: InMemoryJournal, o: Record<string, unknown>) =>
  runDurable({ journal, model: createMockModel(async () => finalTextResult('ok')), prompt: 'gizli istem', ...o } as any);

describe('purgeResource koşumlara ulaşır', () => {
  it("kişinin koşumu, donmuş girdisi ve thread durumu silinir", async () => {
    const journal = new InMemoryJournal();
    await go(journal, { runId: 'pr-1', resourceId: 'u-ayse', threadId: 't-ayse' });
    await journal.put('xthr:t-ayse:dup-x', { at: 1 }); // thread kapsamlı dedup durumu

    expect(await journal.get('pr-1:input')).toBeDefined();
    await purgeResource(journal, 'u-ayse');

    expect(await journal.get('pr-1:input'), 'donmuş girdi (istem + sahip) kaldı').toBeUndefined();
    expect(await journal.get('xthr:t-ayse:dup-x'), 'thread durumu kaldı').toBeUndefined();
    expect((await journal.listKeys!('pr-1:')), 'koşumun kendi anahtarları kaldı').toEqual([]);
  });

  it('BAŞKASININ koşumuna dokunmaz', async () => {
    const journal = new InMemoryJournal();
    await go(journal, { runId: 'pr-2', resourceId: 'u-ayse', threadId: 't-a' });
    await go(journal, { runId: 'pr-3', resourceId: 'u-mehmet', threadId: 't-m' });
    await purgeResource(journal, 'u-ayse');
    expect(await journal.get('pr-2:input')).toBeUndefined();
    expect(await journal.get('pr-3:input'), 'komşunun koşumu silindi').toBeDefined();
  });

  it('sahipsiz koşum bulunamaz — bu SINIR, kod bunu bilerek söylüyor', async () => {
    // Sayım `:input.resourceId` üzerinden. Sahibini kaydetmemiş bir koşum bu listede yoktur ve
    // silinmez. Bu testin varlık sebebi: sınırı GÖRÜNÜR kılmak. Doğum yollarının sahibi yazması
    // bu yüzden bir "temizlik" değil, silmenin ön koşulu.
    const journal = new InMemoryJournal();
    await go(journal, { runId: 'pr-4' }); // sahipsiz
    await purgeResource(journal, 'u-ayse');
    expect(await journal.get('pr-4:input')).toBeDefined();
  });

  it('listRunsPaged olmayan bir journalda eski davranışa DÜŞER, patlamaz', async () => {
    // Silme talebinde throw etmek, yapılmayan bir işi hata gibi göstermek olurdu; sessizce daha
    // fazlasını yaptığını raporlamak ise daha kötü.
    const base = new InMemoryJournal();
    await base.put('xid:res:u-ayse:x', { at: 1 });
    const bare = new Proxy(base, { get: (t, k) => (k === 'listRunsPaged' ? undefined : (t as any)[k]) });
    const n = await purgeResource(bare as any, 'u-ayse');
    expect(n).toBeGreaterThan(0);
    expect(await base.get('xid:res:u-ayse:x')).toBeUndefined();
  });
});
