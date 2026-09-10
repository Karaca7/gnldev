// SAHİPLİK DAMGASI — koşum, sunucunun DOĞRULADIĞI kimlikle mühürlenir.
//
// Motorda sahiplik kilidi zaten vardı (run.ts / RunActorMismatchError, faz4-critical.test.ts):
// bir koşum `actor` ile damgalanmışsa FARKLI bir `actor` onu yeniden süremez. Ama kimse damgayı
// vurmuyordu — kilit kurulu, iki tarafı da boştu ve testin kendi adı bunu "documented auth-less
// bound" diye kabul ediyordu. Bu dosya damganın KAYNAĞINI sabitler.
//
// KAYNAK NEDEN ÖNEMLİ: damga MÜHÜRLÜ bağlamdan gelir (`sealRequestContext` → `serverIdentityOf`),
// isteğin gövdesinden değil. Gövdeden gelseydi çağıran istediği kimlikle damgalanırdı ve kilit
// hiçbir şey ifade etmezdi — "pasaport kontrolünde damgayı yolcunun getirmesi".
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

const gnlOf = (journal: InMemoryJournal) =>
  createGnl({ journal, agents: { a: { model: createMockModel(async () => finalTextResult('ok')) } } });

describe('actor damgası', () => {
  it('mühürlü kimlik koşuma actor olarak yazılır', async () => {
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('a', {
      runId: 'st-1',
      prompt: 'x',
      context: sealRequestContext({}, { resourceId: 'ayse' }),
    });
    const input = await journal.get<{ actor?: string; resourceId?: string }>('st-1:input');
    expect(input?.actor).toBe('ayse');
    expect(input?.resourceId).toBe('ayse');
  });

  it('GÖVDEDEN gelen resourceId damga BASMAZ (kilit kendi kendine verilemez)', async () => {
    // opts.resourceId hâlâ koşumun sahibini ETİKETLER (listeleme/gruplama için) — ama sahiplik
    // KİLİDİNİ kurmaz. İkisi bilerek ayrı: biri "kimin işi" bilgisi, diğeri bir yetki iddiası.
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('a', { runId: 'st-2', prompt: 'x', resourceId: 'kendi-yazdim' });
    const input = await journal.get<{ actor?: string; resourceId?: string }>('st-2:input');
    expect(input?.resourceId).toBe('kendi-yazdim');
    expect(input?.actor).toBeUndefined();
  });

  it('MÜHÜR, gövdeden gelen actor beyanını YENER', async () => {
    // Bu bir öncelik testi, bir varlık testi değil. Damga eklendiğinde aynı nesnede
    // `...(opts.actor ? { actor: opts.actor } : {})` da vardı ve object-literal'de son yazan
    // kazandığı için mührü SESSİZCE eziyordu — doğrulanmış kimliğin üstüne isteğin gövdesi
    // geçiyordu. Kendi kendine verilebilen bir sahiplik damgası, sahiplik kilidini kilit olmaktan
    // çıkarır: kilitlenen isim de saldırganın seçtiği isim olur.
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('a', {
      runId: 'st-5',
      prompt: 'x',
      actor: 'saldirgan',                                        // çağıranın beyanı
      context: sealRequestContext({}, { resourceId: 'ayse' }),   // sunucunun doğruladığı
    });
    const input = await journal.get<{ actor?: string }>('st-5:input');
    expect(input?.actor).toBe('ayse');
  });

  it('mühür yoksa opts.actor GEÇERLİDİR — mühür kurmayan hostun tek kanalı odur', async () => {
    // Geri plan, kaldırma değil: kendi rotasını yazan uygulamalar, CLI ve testler mühürlü bağlam
    // kurmuyor. opts.actor'ü tamamen yok saymak onlarda sahipliği hiç kurulamaz hale getirirdi.
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('a', { runId: 'st-6', prompt: 'x', actor: 'cli-kullanici' });
    const input = await journal.get<{ actor?: string }>('st-6:input');
    expect(input?.actor).toBe('cli-kullanici');
  });

  it('kimlik yoksa damga da yok — auth kurmamış kurulum aynen çalışır', async () => {
    // Geriye dönük sınır: mevcut kullanıcıların koşumları damgasız doğmaya devam eder, kilit
    // ateşlemez, davranış değişmez. Damga bir tercih değil, doğrulanmış kimliğin YAN ÜRÜNÜ.
    const journal = new InMemoryJournal();
    await gnlOf(journal).run('a', { runId: 'st-3', prompt: 'x' });
    const input = await journal.get<{ actor?: string }>('st-3:input');
    expect(input?.actor).toBeUndefined();
  });

  it('damgalı koşumu BAŞKASI süremez — uçtan uca', async () => {
    // faz4 kilidi zaten pinliyor; buradaki fark, damganın ELLE değil MÜHÜRDEN gelmesi.
    const journal = new InMemoryJournal();
    const gnl = gnlOf(journal);
    await gnl.run('a', { runId: 'st-4', prompt: 'x', context: sealRequestContext({}, { resourceId: 'ayse' }) });
    await expect(
      gnl.run('a', { runId: 'st-4', prompt: 'x', context: sealRequestContext({}, { resourceId: 'mehmet' }) }),
    ).rejects.toMatchObject({ name: 'RunActorMismatchError' });
    // Sahibi kendi koşumunu sürebilir.
    await expect(
      gnl.run('a', { runId: 'st-4', prompt: 'x', context: sealRequestContext({}, { resourceId: 'ayse' }) }),
    ).resolves.toBeTruthy();
  });
});
