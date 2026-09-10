// İŞ AKIŞI YOLU, AJAN YOLUNUN İKİ KAPISINI DA ATLIYORDU.
//
// Ajan yolları (`runDurable`/`resumeRun`/`streamDurable`) girişte iki şey soruyor: (1) bu runId
// journal'ın SAHİP OLDUĞU bir anahtar ailesini mi ele geçiriyor (`assertRunIdSafe`), (2) beyan edilen
// threadId gerçekten bu öznenin mi (`memory.getThreadResource`). `runWorkflow` ikisini de sormuyordu
// ve iş akışı koşumları artık `<runId>:input`'a sahip kaydı yazdığı için bu, iki ölçülmüş silme
// silahına dönüşüyordu:
//
// K1 — `POST /workflows/:name/run {runId:'mem', resourceId:'mallory'}` → `mem:input` doğar. O kayıt
// artık mallory'nin bir koşumudur; `purgeResource('mallory')` onu sayar, `purgeRun('mem')` çağırır,
// o da `del('mem:')` yapar. `mem:` TÜM kullanıcıların thread hafızasının kökü. Yani silme HAKKI olan
// bir kullanıcı, kendi verisini silerken herkesinkini siliyor. `thread`, `om`, `xid` ... aynı sınıf.
//
// K2 — `runWorkflow('w', {}, {runId:'x', resourceId:'mallory', threadId:'t-ayse'})` → `x:input`
// mallory'yi sahip, Ayşe'nin thread'ini konu olarak yazar. `purgeResource('mallory')` bu koşumu
// gezer ve `purgeThread('t-ayse')`e ulaşır: Ayşe'nin hafızası, mallory'nin silme hakkıyla silinir.
// Ajan yolunda bu kapı run.ts'te var (ThreadOwnerMismatchError) — iş akışı yolunda yoktu.
//
// Testlerin sabitlediği asıl şey "fırlatıyor mu" değil: HİÇBİR ŞEY YAZILMAMIŞ olması. Reddedilen
// çağrının journal'a bir iz bırakması, reddin kendisini bir yazma yüzeyi yapardı.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

const wf = { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) };

/** Sahibi bilinen tek bir thread — ajan yolundaki kapının okuduğu YETENEĞİN aynısı. */
const memoryOwning = (owners: Record<string, string>) =>
  ({
    getMessages: async () => [],
    append: async () => {},
    getThreadResource: async (threadId: string) => owners[threadId],
  }) as never;

describe('iş akışı runId güvenlik süzgeci (K1)', () => {
  it("runId:'mem' reddedilir ve `mem:input` ASLA yazılmaz", async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    await expect(
      gnl.runWorkflow!('w', {}, { runId: 'mem', resourceId: 'mallory' } as never),
    ).rejects.toThrow(/reserved key family/);
    expect(await journal.get('mem:input')).toBeUndefined();
  });

  it("runId:'thread' de reddedilir — aile listesi tek bir ada özel değil", async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    await expect(
      gnl.runWorkflow!('w', {}, { runId: 'thread', resourceId: 'mallory' } as never),
    ).rejects.toThrow(/reserved key family/);
    expect(await journal.get('thread:input')).toBeUndefined();
  });

  it('sıradan bir runId eskisi gibi çalışır — süzgeç bir charset beyaz listesi değil', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    const r = await gnl.runWorkflow!('w', {}, { runId: 'wf-ok-1', resourceId: 'u-ayse' } as never);
    expect(r.output).toEqual({ ok: true });
    expect((await journal.get<{ resourceId?: string }>('wf-ok-1:input'))?.resourceId).toBe('u-ayse');
  });

  it('runId verilmeyince ÜRETİLEN anonim id süzgeçten doğal geçer', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    const r = await gnl.runWorkflow!('w', {}, {} as never);
    expect(r.runId).toMatch(/^wf-w-/);
    expect(r.output).toEqual({ ok: true });
  });

  it('runNetwork da aynı süzgeçten geçer — aynı sınıf açık, aynı kapı', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      agents: { a: { model: createMockModel(async () => finalTextResult('x')) } },
      networks: { n: { router: createMockModel(async () => finalTextResult('{}')), agents: ['a'] } },
    } as never);
    await expect(gnl.runNetwork!('n', { runId: 'om', task: 'iş' } as never)).rejects.toThrow(/reserved key family/);
    expect(await journal.get('om:input')).toBeUndefined();
  });
});

describe('iş akışı thread sahipliği (K2)', () => {
  it("başkasının thread'ini beyan eden koşum reddedilir ve `:input` yazılmaz", async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      memory: memoryOwning({ 't-ayse': 'u-ayse' }),
      workflows: { w: wf },
    } as never);
    await expect(
      gnl.runWorkflow!('w', {}, { runId: 'hijack-1', resourceId: 'mallory', threadId: 't-ayse' } as never),
    ).rejects.toThrow(/belongs to a different resourceId/);
    expect(await journal.get('hijack-1:input')).toBeUndefined();
  });

  it('kapı, MÜHÜRLENMİŞ (etkili) kimlik çifti üstünde çalışır — beyan değil', async () => {
    // Mühürlü resourceId beyanı eziyor; kapı ezilmiş değeri görmezse mallory kendi adını gövdeye
    // yazıp mühürlü kurbanın kimliğiyle geçebilirdi (ya da tersi).
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      memory: memoryOwning({ 't-ayse': 'u-ayse' }),
      workflows: { w: wf },
    } as never);
    await expect(
      gnl.runWorkflow!('w', {}, {
        runId: 'hijack-2',
        resourceId: 'u-ayse', // gövdedeki yalan
        threadId: 't-ayse',
        context: sealRequestContext({}, { resourceId: 'mallory' }),
      } as never),
    ).rejects.toThrow(/belongs to a different resourceId/);
    expect(await journal.get('hijack-2:input')).toBeUndefined();
  });

  it("kendi thread'i geçer", async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({
      journal,
      memory: memoryOwning({ 't-ayse': 'u-ayse' }),
      workflows: { w: wf },
    } as never);
    const r = await gnl.runWorkflow!('w', {}, { runId: 'own-1', resourceId: 'u-ayse', threadId: 't-ayse' } as never);
    expect(r.output).toEqual({ ok: true });
    expect((await journal.get<{ threadId?: string }>('own-1:input'))?.threadId).toBe('t-ayse');
  });

  it('sahibi HENÜZ olmayan thread geçer — ilk tur bir thread yaratır', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, memory: memoryOwning({}), workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'new-1', resourceId: 'u-ayse', threadId: 't-yeni' } as never);
    expect((await journal.get<{ threadId?: string }>('new-1:input'))?.threadId).toBe('t-yeni');
  });

  it("memory'siz gnl'de threadId beyanı eskisi gibi geçer — ajan yollarıyla parite sınırı", async () => {
    // Kapı ancak DOĞRULAYABİLECEK bilgi varken kurulur. Memory yoksa sahibi kimse bilmiyor demektir;
    // burada reddetmek, doğrulanamayan bir iddiayı suç saymak olurdu. Ajan yolu da (run.ts) tam
    // olarak bu koşulla susuyor — parite kasıtlı, sınır dürüstçe yazılı.
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, memory: false, workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'nomem-1', resourceId: 'mallory', threadId: 't-ayse' } as never);
    expect((await journal.get<{ threadId?: string }>('nomem-1:input'))?.threadId).toBe('t-ayse');
  });
});
