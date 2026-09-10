// AĞ KOŞUMLARI DA SAHİPLİ DOĞMALI — router'ın KENDİ koşumu sahipsiz kalıyordu.
//
// Yama seti iş akışına sahip kaydını ekledi (`<runId>:input` → `{at, resourceId?, actor?, threadId?,
// workflow}`). Ağ yolunun muadili yoktu ve eksik olan şey yalnız bir alan değildi: router'ın kendi
// `<runId>:net:route/step` kayıtları GÖREV METNİNİ ve alt-ajan çıktılarını taşıyor — yani kişisel
// veri. Sahibi yazılmayınca:
//   • `purgeResource(u)` o koşumu SAYMIYOR (sayım `:input.resourceId` üstünden) → silme yarım kalıyor,
//   • `ownershipDenied` sahibi bulamıyor → kapı sessizce geçiyor.
// Alt-ajanlar zaten kimliği devralıyordu (runSubAgent'a resourceId/threadId/actor iniyor); sahipsiz
// kalan tam olarak ROUTER'IN KENDİSİYDİ — yani üstteki kök koşum.
//
// MUAFİYET AYNEN KORUNUYOR: özne beyan edilmemişse hiçbir şey yazılmaz. Uydurulmuş sahip yok.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { purgeResource } from '../src/retention.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

const final = (answer: string) => JSON.stringify({ action: 'final', answer });

/** Yönlendirme yapmadan tek turda biten bir router — bu dosyanın konusu kimlik, rota değil. */
const netGnl = (journal: InMemoryJournal, memory?: unknown) =>
  createGnl({
    journal,
    ...(memory !== undefined ? { memory } : {}),
    agents: { a: { model: createMockModel(async () => finalTextResult('alt')) } },
    networks: { n: { router: createMockModel(async () => finalTextResult(final('bitti'))), agents: ['a'] } },
  } as never);

/** Sahibi bilinen thread'ler — ajan/iş akışı kapılarının okuduğu YETENEĞİN aynısı. */
const memoryOwning = (owners: Record<string, string>) =>
  ({
    getMessages: async () => [],
    append: async () => {},
    getThreadResource: async (threadId: string) => owners[threadId],
  }) as never;

describe('ağ kimliği', () => {
  it('beyan edilen özne :input a yazılır — kayıt kendini `network` diye tanıtır', async () => {
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal);
    await gnl.runNetwork!('n', { runId: 'net-1', task: 'iş', resourceId: 'u-ayse', actor: 'u-ayse', threadId: 't-ayse' } as never);
    const input = await journal.get<{ resourceId?: string; actor?: string; threadId?: string; network?: string }>('net-1:input');
    expect(input?.resourceId).toBe('u-ayse');
    expect(input?.actor).toBe('u-ayse');
    expect(input?.threadId).toBe('t-ayse');
    expect(input?.network).toBe('n'); // hangi ağ — iş akışındaki `workflow` alanının kardeşi
  });

  it('MÜHÜRLÜ kimlik beyanı ezer', async () => {
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal);
    await gnl.runNetwork!('n', {
      runId: 'net-2', task: 'iş', resourceId: 'gövdeden', context: sealRequestContext({}, { resourceId: 'u-dogrulanmis' }),
    } as never);
    expect((await journal.get<{ resourceId?: string }>('net-2:input'))?.resourceId).toBe('u-dogrulanmis');
  });

  it('özne beyan edilmezse HİÇBİR ŞEY yazılmaz — muafiyet korunuyor', async () => {
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal);
    await gnl.runNetwork!('n', { runId: 'net-3', task: 'iş' } as never);
    expect(await journal.get('net-3:input')).toBeUndefined();
  });

  it('purgeResource ağ koşumunu BULUR — sahip kaydının asıl işi bu', async () => {
    // Sahipsizken bu koşum `listRunsPaged({resourceId})` sayımında hiç görünmüyordu: görev metni ve
    // router kararları silme talebinden sonra journal'da kalıyordu.
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal);
    await gnl.runNetwork!('n', { runId: 'net-4', task: 'gizli görev', resourceId: 'u-ayse' } as never);
    expect((await journal.listRunsPaged!({ resourceId: 'u-ayse' })).items.map((r) => r.runId)).toContain('net-4');
    await purgeResource(journal, 'u-ayse');
    expect(await journal.get('net-4:input')).toBeUndefined();
    expect(await journal.listKeys!('net-4:'), 'router kararları ve görev metni kaldı').toEqual([]);
  });

  it("ağ runId'sine ajan yolundan girmek NotAnAgentRunError — hata 'network' der", async () => {
    // `:input` artık iki iş yapıyor: ajan yolunda donmuş istek, iş akışı/batch/AĞ yolunda kimlik
    // kaydı. Ajan yolu "donmuş" kararını anahtarın DOLULUĞUNDAN veriyor — tanıtılmayan bir kimlik
    // kaydı boş bir isteğin modele gitmesi demekti, üstelik satırlar ağın önekine düşerdi.
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal);
    await gnl.runNetwork!('n', { runId: 'net-5', task: 'iş', resourceId: 'u-ayse' } as never);
    await expect(
      runDurable({ journal, model: createMockModel(async () => finalTextResult('x')), runId: 'net-5', prompt: 'x' } as never),
    ).rejects.toThrow(/network 'n'/);
  });
});

describe('ağ thread sahipliği', () => {
  it("başkasının thread'ini beyan eden ağ koşumu reddedilir ve `:input` yazılmaz", async () => {
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal, memoryOwning({ 't-ayse': 'u-ayse' }));
    await expect(
      gnl.runNetwork!('n', { runId: 'net-hj-1', task: 'iş', resourceId: 'mallory', threadId: 't-ayse' } as never),
    ).rejects.toThrow(/belongs to a different resourceId/);
    expect(await journal.get('net-hj-1:input')).toBeUndefined();
  });

  it('kapı MÜHÜRLENMİŞ çift üstünde çalışır — beyan değil', async () => {
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal, memoryOwning({ 't-ayse': 'u-ayse' }));
    await expect(
      gnl.runNetwork!('n', {
        runId: 'net-hj-2',
        task: 'iş',
        resourceId: 'u-ayse', // gövdedeki yalan
        threadId: 't-ayse',
        context: sealRequestContext({}, { resourceId: 'mallory' }),
      } as never),
    ).rejects.toThrow(/belongs to a different resourceId/);
    expect(await journal.get('net-hj-2:input')).toBeUndefined();
  });

  it("kendi thread'i geçer", async () => {
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal, memoryOwning({ 't-ayse': 'u-ayse' }));
    const r = await gnl.runNetwork!('n', { runId: 'net-own-1', task: 'iş', resourceId: 'u-ayse', threadId: 't-ayse' } as never);
    expect(r.text).toBe('bitti');
    expect((await journal.get<{ threadId?: string }>('net-own-1:input'))?.threadId).toBe('t-ayse');
  });
});

describe('OKUNAMAYAN sahip koşumu DÜŞÜRÜR — bilinmeyen sahiple aynı şey değil', () => {
  // Depo kararı bu turda değişti. Eski hal `.catch(() => undefined)` idi: deposu arızalı bir kurulumda
  // kapı sessizce devre dışı kalıyordu — yani en çok ihtiyaç duyulduğu anda. "Sahibi HENÜZ olmayan
  // thread" (ilk tur) ile "sahibi SORULAMAYAN thread" aynı cevabı veriyordu ve ikisi aynı şey değil:
  // biri masumiyet, diğeri bilgisizlik. Bilgisizlik geçiş hakkı değildir.
  const memoryThrowing = () =>
    ({
      getMessages: async () => [],
      append: async () => {},
      getThreadResource: async () => { throw new Error('bellek deposu okunamadı'); },
    }) as never;

  const wf = { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) };

  it('iş akışında: okuma hatası yayılır, koşum başlamaz', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, memory: memoryThrowing(), workflows: { w: wf } } as never);
    await expect(
      gnl.runWorkflow!('w', {}, { runId: 'loud-wf-1', resourceId: 'u-ayse', threadId: 't-ayse' } as never),
    ).rejects.toThrow(/bellek deposu okunamadı/);
    expect(await journal.get('loud-wf-1:input')).toBeUndefined();
  });

  it('ağda: aynı sözleşme', async () => {
    const journal = new InMemoryJournal();
    const gnl = netGnl(journal, memoryThrowing());
    await expect(
      gnl.runNetwork!('n', { runId: 'loud-net-1', task: 'iş', resourceId: 'u-ayse', threadId: 't-ayse' } as never),
    ).rejects.toThrow(/bellek deposu okunamadı/);
    expect(await journal.get('loud-net-1:input')).toBeUndefined();
  });
});
