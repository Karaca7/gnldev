// DÖNEM DEVRİ KİMLİĞİ DÜŞÜRMEZ.
//
// Devir tohumu yalnız `messages` (+ `system`) taşıyordu; `threadId`, `resourceId`, `actor` ve
// `agent` düşüyordu. Sonuç kalıcı: yeni koşumun `:input`'u ilk yazan kazanır, yani SAHİPLİ bir
// koşum dönem devrinde SAHİPSİZ doğuyor ve bir daha sahiplenilemiyor.
//
// Sahipsizlik sessizce her kapıyı açar: `ownershipDenied` `!owner` dalında geçer, actor kilidi
// ateşlemez, `purgeResource` o koşumu hiç bulamaz. Devir bir kimlik DEĞİŞİMİ değil, aynı işin
// devamıdır — kimliğin düşmesi için bir sebep yok, düşmesinin bedeli ise üç ayrı yüzeyde ödeniyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { rolloverRun } from '../src/rollover.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('rollover kimliği devreder', () => {
  it('threadId, resourceId, actor ve agent yeni koşuma taşınır', async () => {
    const journal = new InMemoryJournal();
    // `agentName` başlıkta sayılan dördüncü alan ve iddiası eksikti — koşum ona hiç isim vermiyordu,
    // yani `agent` her hâlükârda `undefined` devrediyordu ve test bunu göremezdi. Motorda alan
    // `agentName` diye geliyor, journal'a `agent` diye donuyor (persistInput), devir onu o adla
    // taşıyor: üç adın da aynı zinciri gösterdiği tek yer burası.
    await runDurable({
      runId: 'ro-1', journal, model: createMockModel(async () => finalTextResult('ok')),
      prompt: 'x', threadId: 't-1', resourceId: 'u-ayse', actor: 'u-ayse', agentName: 'satis',
    } as any);

    const { newRunId } = await rolloverRun(journal, 'ro-1');
    const seed = await journal.get<{ resourceId?: string; threadId?: string; actor?: string; agent?: string }>(runKeys.input(newRunId));
    expect(seed?.resourceId).toBe('u-ayse');
    expect(seed?.threadId).toBe('t-1');
    expect(seed?.actor).toBe('u-ayse');
    expect(seed?.agent, 'ajan adı devirde düştü — yeni koşum etiketsiz doğuyor').toBe('satis');
  });

  it('kimliksiz koşumda tohum da kimliksiz — alan UYDURULMAZ', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'ro-2', journal, model: createMockModel(async () => finalTextResult('ok')), prompt: 'x' } as any);
    const { newRunId } = await rolloverRun(journal, 'ro-2');
    const seed = await journal.get<Record<string, unknown>>(runKeys.input(newRunId));
    expect('resourceId' in (seed ?? {})).toBe(false);
    expect('actor' in (seed ?? {})).toBe(false);
  });

  it('devredilen kimlik KALICI: yeni koşum sahibiyle doğar', async () => {
    // `:input` ilk yazan kazanır. Tohum sahibi taşımazsa yeni koşum sonsuza dek sahipsiz kalır —
    // sonradan `resourceId` göndermek bile onu düzeltmez.
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'ro-3', journal, model: createMockModel(async () => finalTextResult('ok')),
      prompt: 'x', threadId: 't-3', resourceId: 'u-mehmet',
    } as any);
    const { newRunId } = await rolloverRun(journal, 'ro-3');
    await runDurable({ runId: newRunId, journal, model: createMockModel(async () => finalTextResult('devam')) } as any);
    expect((await journal.get<{ resourceId?: string }>(runKeys.input(newRunId)))?.resourceId).toBe('u-mehmet');
  });
});
