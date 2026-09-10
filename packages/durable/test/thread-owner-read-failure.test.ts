// OKUNAMAYAN SAHİP, SAHİPSİZ SAYILMAZ.
//
// Özne↔thread kapısı sahibi `memory.getThreadResource` ile soruyordu ve cevabı
// `.catch(() => undefined)` ile alıyordu. O tek satır, kapının en çok gerektiği anı — deponun
// arızalı olduğu anı — kapının hiç sorulmadığı ana çeviriyor: okuma hatası "sahibi yok" gibi
// okunuyor, `!owner` dalı sessizce geçiyor ve çağıran başkasının thread'ine yazıyor.
//
// Depo kararı zaten verilmişti: registry.ts'teki iş akışı ve ağ kapıları `.catch`siz yazıldı ve
// gerekçesi orada kelimesi kelimesine duruyor. Ajan yolu üç yerde eski hâlinde kalmıştı.
//
// ÇİZGİ: BİLİNMEYEN sahip geçer (sahibi henüz olmayan thread'i ilk tur yaratır), OKUNAMAYAN sahip
// düşürür. İkisi aynı şey değil — biri bir cevap, öteki cevabın yokluğu.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { createMockModel, createMockStreamAgent, finalTextResult } from './mock.js';

const BOOM = 'thread deposu arızalı';

/** Sahibi SORULABİLEN ama cevap veremeyen bellek. */
const brokenMemory = () => ({
  getThreadResource: async () => { throw new Error(BOOM); },
  getMessages: async () => [],
  append: async () => {},
}) as any;

/** Sahibi HENÜZ olmayan thread — okunabiliyor, cevabı "yok". */
const unownedMemory = () => ({
  getThreadResource: async () => undefined,
  getMessages: async () => [],
  append: async () => {},
}) as any;

describe('getThreadResource okuma hatası kapıyı açmaz', () => {
  it('özne BEYAN EDİLMİŞKEN okuma hatası koşumu düşürür', async () => {
    // Kapının dar hâli: beyan var, sahip okunamıyor. Eskiden `undefined` okunup geçiliyordu.
    const journal = new InMemoryJournal();
    await expect(runDurable({
      runId: 'to-1', journal, model: createMockModel(async () => finalTextResult('ok')),
      prompt: 'x', threadId: 't-ayse', resourceId: 'u-mallory', memory: brokenMemory(),
    } as any)).rejects.toThrow(BOOM);
  });

  it('özne BEYAN EDİLMEMİŞKEN de düşürür — benimseme okuması da sessiz kalamaz', async () => {
    // Benimseme yolu: sahip okunamazsa koşum SAHİPSİZ doğuyordu ve `:input` ilk yazan kazandığı
    // için bu kalıcıydı — sahipsizlik sonradan düzeltilemez.
    const journal = new InMemoryJournal();
    await expect(runDurable({
      runId: 'to-2', journal, model: createMockModel(async () => finalTextResult('ok')),
      prompt: 'x', threadId: 't-ayse', memory: brokenMemory(),
    } as any)).rejects.toThrow(BOOM);
    expect(await journal.get('to-2:input'), 'sahipsiz bir girdi donduruldu').toBeUndefined();
  });

  it('AKIŞ yolu da aynı — chat/agui buradan geçiyor', async () => {
    const journal = new InMemoryJournal();
    await expect(streamDurable({
      runId: 'to-3', journal, model: createMockStreamAgent(),
      prompt: 'x', threadId: 't-ayse', resourceId: 'u-mallory', memory: brokenMemory(),
    } as any)).rejects.toThrow(BOOM);
  });

  it('sahibi HENÜZ olmayan thread eskisi gibi geçer — cevap "yok" da bir cevaptır', async () => {
    const journal = new InMemoryJournal();
    const r = await runDurable({
      runId: 'to-4', journal, model: createMockModel(async () => finalTextResult('ok')),
      prompt: 'x', threadId: 't-yeni', resourceId: 'u-ayse', memory: unownedMemory(),
    } as any);
    expect(r.text).toBe('ok');
  });
});
