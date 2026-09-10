// BENİMSENEN THREAD SAHİBİ `:input`'A YAZILIR.
//
// Özne beyan edilmediğinde bellek zaten thread'in sahibini benimsiyor (prepareMemoryContext) —
// geçmişi onun adına okuyor, onun çalışma belleğini yüklüyor. Ama `persistInput`'a HAM `resourceId`
// gidiyordu, benimsenen değil. Sonuç: koşum bellekte Ayşe'nin, journal'da SAHİPSİZ.
//
// Neden önemli: `:input` ilk yazan kazanır, yani sahipsizlik KALICI. Ve sahipsiz bir koşumda
// `ownershipDenied` sessiz geçer (`!owner` dalı) — sonradan gelen bir çağrı kendi öznesini beyan
// edip cevabı kurbanın thread'ine yazdırabiliyordu.
//
// Kural: belleğin OKUDUĞU sahip ile journal'ın YAZDIĞI sahip aynı olmalı. İki gerçeklik olursa
// kapı yanlış olanı okur.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

function memoryWithOwner(owner: string) {
  return {
    getThreadResource: async () => owner,
    getMessages: async () => [],
    append: async () => {},
  } as any;
}

const go = (journal: InMemoryJournal, o: Record<string, unknown>) =>
  runDurable({ journal, model: createMockModel(async () => finalTextResult('ok')), prompt: 'x', ...o } as any);

describe('benimsenen sahip', () => {
  it('özne beyan edilmezse THREADİN sahibi journala yazılır', async () => {
    const journal = new InMemoryJournal();
    await go(journal, { runId: 'ad-1', threadId: 't-ayse', memory: memoryWithOwner('u-ayse') });
    expect((await journal.get<{ resourceId?: string }>('ad-1:input'))?.resourceId).toBe('u-ayse');
  });

  it('BAŞKASININ thread\'ine beyan edilen özne REDDEDİLİR', async () => {
    // Bu test ilk yazıldığında "beyan benimsemeyi ezer" diyordu ve YEŞİLDİ — yani sızıntıyı doğru
    // davranış olarak sabitliyordu. Beyan gerçekten ezerse, thread'i adresleyen herkes onun
    // geçmişini modele yükletir ve turunu oraya ekler. "Kimin adına" sorusunun cevabı, "hangi
    // konuşma" sorusunun cevabıyla çelişemez.
    const journal = new InMemoryJournal();
    await expect(
      go(journal, { runId: 'ad-2', threadId: 't-ayse', resourceId: 'u-beyan', memory: memoryWithOwner('u-ayse') }),
    ).rejects.toMatchObject({ name: 'ThreadOwnerMismatchError' });
  });

  it('beyan sahiple UYUŞUYORSA sorun yok', async () => {
    const journal = new InMemoryJournal();
    await go(journal, { runId: 'ad-2b', threadId: 't-ayse', resourceId: 'u-ayse', memory: memoryWithOwner('u-ayse') });
    expect((await journal.get<{ resourceId?: string }>('ad-2b:input'))?.resourceId).toBe('u-ayse');
  });

  it('thread sahipsizse koşum da sahipsiz kalır — sahip UYDURULMAZ', async () => {
    // İlk tur thread'i yaratır; o anda sahip yoktur. Bilinmeyen bir sahibi doldurmak, kapıyı
    // yanlış bir isimle kilitlemek olurdu.
    const journal = new InMemoryJournal();
    await go(journal, { runId: 'ad-3', threadId: 't-yeni', memory: { getThreadResource: async () => undefined, getMessages: async () => [], append: async () => {} } as any });
    expect((await journal.get<{ resourceId?: string }>('ad-3:input'))?.resourceId).toBeUndefined();
  });

  it('bellek yoksa davranış değişmez', async () => {
    const journal = new InMemoryJournal();
    await go(journal, { runId: 'ad-4', threadId: 't-x' });
    expect((await journal.get<{ resourceId?: string }>('ad-4:input'))?.resourceId).toBeUndefined();
  });
});
