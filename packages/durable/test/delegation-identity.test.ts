// DEVRETMEK, KORUMA KATMANINI KAPATMAK DEĞİLDİR.
//
// Alt-ajan sınırından taint, limits ve toolPolicy yıllardır geçiyordu — kimlik geçmiyordu. Yani
// "devret" sessizce "sahibi düşür" anlamına geliyordu.
//
// Bedeli üç ayrı yüzeyde ödeniyordu: (1) `ctx.resourceId` olmayınca kanallar-arası kimlik planı
// (XID) hiç kurulmuyor, aynı ödeme başka kanaldan gelince kapı kör kalıyor; (2) `:input`'ta sahip
// olmayınca `ownershipDenied` `!owner` dalında geçiyor ve actor kilidi ateşlemiyor; (3)
// `purgeResource` o koşumu kişi silme talebinde hiç bulamıyor.
//
// Asimetri ipucuydu: taşınan üç şeyin üçü de bir kez fark edilmişti. Kimlik hiç fark edilmemişti —
// oysa alt ajan başka bir kişi değil, aynı isteğin bir kare derini.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, nestedAgentRunId } from '../src/journal.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { createMockModel, finalTextResult, toolCallResult, countToolResults } from './mock.js';

/** Ana ajan bir kez alt ajanı çağırır, sonra bitirir. */
const delegatingModel = (toolCallId: string) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0
      ? toolCallResult('agent_alt', toolCallId, { task: 'bir şey yap' })
      : finalTextResult('bitti'));

function gnlOf(journal: InMemoryJournal, toolCallId: string) {
  return createGnl({
    journal,
    agents: {
      ana: { model: delegatingModel(toolCallId), agents: ['alt'] },
      alt: { model: createMockModel(async () => finalTextResult('alt tamam')) },
    },
  } as never);
}

describe('delegasyon kimliği taşır', () => {
  it('alt koşum ana koşumun sahibiyle doğar', async () => {
    const journal = new InMemoryJournal();
    const tcid = 'call-devret';
    await gnlOf(journal, tcid).run('ana', {
      runId: 'dg-1',
      prompt: 'devret',
      threadId: 't-ayse',
      context: sealRequestContext({}, { resourceId: 'u-ayse' }),
    } as never);

    const child = nestedAgentRunId('dg-1', tcid);
    const childInput = await journal.get<{ resourceId?: string; threadId?: string; actor?: string }>(runKeys.input(child));
    expect(childInput, 'alt koşumun :input kaydı hiç yazılmamış').toBeDefined();
    expect(childInput?.resourceId).toBe('u-ayse');
    expect(childInput?.threadId).toBe('t-ayse');
    // Damga da iner: aksi hâlde alt koşum sahipli AMA kilitsiz olurdu — yarım bir devir.
    expect(childInput?.actor).toBe('u-ayse');
  });

  it('ana koşum sahipsizse alt koşum da sahipsiz — kimlik UYDURULMAZ', async () => {
    const journal = new InMemoryJournal();
    const tcid = 'call-devret-2';
    await gnlOf(journal, tcid).run('ana', { runId: 'dg-2', prompt: 'devret' } as never);
    const child = nestedAgentRunId('dg-2', tcid);
    const childInput = await journal.get<Record<string, unknown>>(runKeys.input(child));
    expect('resourceId' in (childInput ?? {})).toBe(false);
    expect('actor' in (childInput ?? {})).toBe(false);
  });

  it('kimlik kişi-silme yüzeyinden GÖRÜNÜR hâle gelir', async () => {
    // Asıl bedel buydu: sahipsiz alt koşum, `listRuns({resourceId})` süzgecinde hiç görünmüyordu,
    // yani kişi silme talebinin keşif listesi baştan eksikti.
    const journal = new InMemoryJournal();
    const tcid = 'call-devret-3';
    await gnlOf(journal, tcid).run('ana', {
      runId: 'dg-3', prompt: 'devret', context: sealRequestContext({}, { resourceId: 'u-mehmet' }),
    } as never);
    const runs = await journal.listRunsPaged!({ resourceId: 'u-mehmet', limit: 50 });
    const ids = runs.items.map((r) => r.runId);
    expect(ids).toContain('dg-3');
    expect(ids, 'alt koşum kişinin koşum listesinde yok — silme onu bulamaz').toContain(nestedAgentRunId('dg-3', tcid));
  });
});
