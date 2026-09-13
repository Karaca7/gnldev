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
import { runDurable, resumeRun } from '../src/run.js';
import { derivedRunId } from '../src/hash.js';
import { RunInputMismatchError } from '../src/errors.js';
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

// DEVİR TOHUMUNDA PARMAK İZİ YOKTU — yani `#2` bir vakumda doğuyordu.
//
// Türetilmiş bir id'de girdi parmak izi KOŞULSUZ denetlenir (§5): `strictInput` yok, opt-out yok,
// çünkü `run1_<dijest>` zaten "bu iş şu iş" iddiasıdır. Denetim `frozen.hash` üstünden yürüyor.
//
// Devir tohumunu `rolloverRun` yazıyor ve `hash` alanını hiç koymuyordu. `persistInput` ise
// `:input` doluysa hiç yazmıyor. İkisi birleşince `#2` KALICI olarak parmak izsiz kalıyordu: yeni
// döneme ne gönderilirse gönderilsin, koşulsuz denetim `frozen.hash === undefined` dalında sessizce
// geçiyor ve bambaşka bir içerik "aynı işin devamı" diye replay ediliyordu. Yani eksenin en çok
// korunması gereken ucu — bir işin ikinci, üçüncü dönemi — tek korumasız ucuydu.
describe('devir tohumu girdi parmak izini taşır', () => {
  const model = () => createMockModel(async () => finalTextResult('ok'));

  /** Bir dönem koşar ve devreder; türetilmiş ya da ham id ile. */
  async function devret(journal: InMemoryJournal, runId: string) {
    await runDurable({ runId, journal, model: model(), prompt: 'dönem 1' } as any);
    return (await rolloverRun(journal, runId)).newRunId;
  }

  it('tohum `hash` alanıyla yazılır', async () => {
    const journal = new InMemoryJournal();
    const newRunId = await devret(journal, derivedRunId('ana', 'resource', 'u-1', 'mutabakat'));
    const seed = await journal.get<{ hash?: string; messages?: unknown[] }>(runKeys.input(newRunId));
    expect(seed?.hash, 'devir tohumunda parmak izi yok — türetilmiş eksen vakumda').toBeDefined();
  });

  it('türetilmiş `#2`\'ye FARKLI içerikle çağrı 409 verir', async () => {
    const journal = new InMemoryJournal();
    const base = derivedRunId('ana', 'resource', 'u-1', 'mutabakat');
    const newRunId = await devret(journal, base);
    expect(newRunId).toBe(`${base}#2`);

    // Devrin sözleşmesi: yeni dönem tohumun İÇERİĞİYLE sürdürülür (rollover.ts'in INPUT-SEED
    // CONTRACT paragrafı). Bu çağrı bambaşka bir istek gönderiyor ve bugüne kadar sessizce geçiyordu.
    await expect(
      runDurable({ runId: newRunId, journal, model: model(), prompt: 'bambaşka bir iş' } as any),
    ).rejects.toBeInstanceOf(RunInputMismatchError);
  });

  it('tohumun KENDİ içeriğiyle sürdürmek geçer — devir sözleşmesi kırılmaz', async () => {
    const journal = new InMemoryJournal();
    const base = derivedRunId('ana', 'resource', 'u-2', 'mutabakat');
    await runDurable({ runId: base, journal, model: model(), prompt: 'dönem 1', system: 'sen bir ajansın' } as any);
    const r = await rolloverRun(journal, base);
    // İki belgelenmiş sürdürme biçimi de geçmeli: `messages` ile açık çağrı…
    await expect(
      runDurable({ runId: r.newRunId, journal, model: model(), messages: r.messages, system: 'sen bir ajansın' } as any),
    ).resolves.toBeDefined();
    // …ve rollover.ts'in başında yazan asıl sürdürme biçimi: `resumeRun` tohumu okuyup geri besler.
    await expect(resumeRun(r.newRunId, { journal, model: model() } as any)).resolves.toBeDefined();
  });

  it('HAM devirde parmak izi yalnız strictInput ile bağlar — eski davranış korunur', async () => {
    const journal = new InMemoryJournal();
    const newRunId = await devret(journal, 'ham-dönem');
    expect(newRunId).toBe('ham-dönem@2');
    // Ham id'de gate opt-in: farklı içerik strictInput'suz geçmeye devam eder…
    await expect(
      runDurable({ runId: newRunId, journal, model: model(), prompt: 'başka' } as any),
    ).resolves.toBeDefined();
    // …ama strictInput istendiğinde artık bağlayacak bir parmak izi VAR.
    await expect(
      runDurable({ runId: newRunId, journal, model: model(), prompt: 'yine başka', strictInput: true } as any),
    ).rejects.toBeInstanceOf(RunInputMismatchError);
  });
});
