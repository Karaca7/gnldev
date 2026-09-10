// İŞ AKIŞI KOŞUMLARI ARTIK SAHİPLİ DOĞABİLİR.
//
// Görünür sonucu şuydu: `POST /workflows/runs/:id/cancel` sahiplik kapısını ÇAĞIRIYOR, ama kapı
// sahibi `<runId>:input`'tan okuyor ve iş akışı oraya hiç yazmıyordu (`<runId>:wf:_input` ayrı bir
// anahtar). Yani kontrol her zaman sessizce geçiyordu. Çağrılan ama hiçbir zaman iş görmeyen bir
// kapı, olmayan kapıdan daha kötüdür: okuyan onu bir koruma sanar.
//
// Kimlik `:input`'a yazılıyor, iş akışının kendi `:wf:_input`'una değil — çünkü sahiplik kapısı,
// `listRuns({resourceId})` süzgeci ve `purgeResource` üçü de O anahtarı okuyor. Başka bir yere
// koymak üç yüzeyi birden yeniden yazmak olurdu.
//
// MUAFİYET KORUNUYOR: "org düzeyi iş, öznesi yok" gerçek bir kullanım. Özne beyan edilmezse hiçbir
// şey yazılmaz — uydurulmuş sahip yok. Muafiyetin yanlış olduğu tek yer, iş akışının bir AJANIN
// İÇİNDEN doğduğu hâl: o, belli bir kullanıcının koşumundan çıkıyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, nestedAgentRunId } from '../src/journal.js';
import { createGnl, sealRequestContext } from '../src/registry.js';
import { createMockModel, finalTextResult, toolCallResult, countToolResults } from './mock.js';

const wf = { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) };

describe('iş akışı kimliği', () => {
  it('beyan edilen özne :input a yazılır — sahiplik kapısı artık bir şey bulur', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'wf-1', resourceId: 'u-ayse', actor: 'u-ayse' } as never);
    const input = await journal.get<{ resourceId?: string; actor?: string; workflow?: string }>('wf-1:input');
    expect(input?.resourceId).toBe('u-ayse');
    expect(input?.actor).toBe('u-ayse');
    expect(input?.workflow).toBe('w'); // hangi iş akışı — kayıt kendini tanıtsın
  });

  it('MÜHÜRLÜ kimlik beyanı ezer', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, {
      runId: 'wf-2', resourceId: 'gövdeden', context: sealRequestContext({}, { resourceId: 'u-dogrulanmis' }),
    } as never);
    expect((await journal.get<{ resourceId?: string }>('wf-2:input'))?.resourceId).toBe('u-dogrulanmis');
  });

  it('özne beyan edilmezse HİÇBİR ŞEY yazılmaz — muafiyet korunuyor', async () => {
    const journal = new InMemoryJournal();
    const gnl = createGnl({ journal, workflows: { w: wf } } as never);
    await gnl.runWorkflow!('w', {}, { runId: 'wf-3' } as never);
    expect(await journal.get('wf-3:input')).toBeUndefined();
  });

  it('AJAN İÇİNDEN doğan iş akışı ebeveynin sahibini devralır', async () => {
    // Muafiyetin yanlış olduğu tek yer burası: bu iş akışı bir org görevi değil, bir kullanıcının
    // koşumunun devamı. Sahipsiz doğması, o kullanıcının silme talebinde bulunamaması demekti.
    const journal = new InMemoryJournal();
    const tcid = 'call-wf';
    const gnl = createGnl({
      journal,
      workflows: { w: wf },
      agents: {
        ana: {
          model: createMockModel(async ({ prompt }: any) =>
            countToolResults(prompt) === 0 ? toolCallResult('workflow_w', tcid, { input: {} }) : finalTextResult('bitti')),
          workflows: ['w'],
        },
      },
    } as never);
    await gnl.run('ana', { runId: 'wf-4', prompt: 'çalıştır', context: sealRequestContext({}, { resourceId: 'u-mehmet' }) } as never);
    const child = nestedAgentRunId('wf-4', tcid, 'wf');
    expect((await journal.get<{ resourceId?: string }>(`${child}:input`))?.resourceId).toBe('u-mehmet');
  });
});
