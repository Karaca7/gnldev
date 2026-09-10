// KİMLİK KAYDI, DONMUŞ AJAN GİRDİSİ DEĞİLDİR.
//
// Batch item'ları ve iş akışı koşumları artık `<runId>:input` altına bir KİMLİK kaydı yazıyor
// ({at, resourceId?, workflow|batch, …}) — çünkü sahiplik kapısı, `listRuns({resourceId})` süzgeci
// ve `purgeResource` üçü de O anahtarı okuyor. Yan etkisi ölçüldü: ajan yolu aynı anahtarın
// VARLIĞINI "girdi donmuş" diye okuyor (`runDurable`/`streamDurable`/`resumeRun`). Bu id'lerden biri
// ajan yoluna verildiğinde `adoptFrozenInput` rest.prompt/messages/system'ı kaydın (var olmayan)
// alanlarına eşitliyor — yani UNDEFINED'a: boş girdiyle model çağrısı, ve o id'nin altına ajan-koşum
// kayıtları karışıyor. batch.ts'in kendi başlık yorumu ihlal edilen invaryantı zaten yazıyordu:
// "resumeRun'la RESUME EDİLMEZ (frozen :input yok)".
//
// AYIRT EDİCİ, ve iki yarımı da gerekli: kimlik kayıtları kendini TANITIR (`workflow:`/`batch:`) VE
// prompt/messages/system'ın hiçbirini taşımaz. Gerçek bir persistInput çıktısında prompt ya da
// messages daima vardır — bu yüzden meşru "prompt'suz ama messages'lı" koşum benimsenmeye devam eder.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun, streamDurable } from '../src/run.js';
import { createBatch } from '../src/batch.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, finalTextResult } from './mock.js';

const model = () => createMockModel(async () => finalTextResult('bitti'));

/** Sahipli bir batch koşumu — `batch:<id>:<key>:input` kimlik kaydını GERÇEK yoldan doğurur. */
async function seedBatchItem(journal: InMemoryJournal): Promise<string> {
  const b = createBatch(journal, {
    tool: { sideEffect: true, execute: async () => ({ paid: true }) } as never,
    toolName: 'pay',
    itemKey: (i: unknown) => (i as { ref: string }).ref,
    resourceId: 'u-ayse',
  });
  const list = [{ ref: 'F-1', amount: 10 }];
  const plan = await b.preflight('b1', list);
  await b.run('b1', list, { planToken: plan.token });
  return 'batch:b1:F-1';
}

/** Sahipli bir iş akışı koşumu — `wf-x:input` kimlik kaydını GERÇEK yoldan doğurur. */
async function seedWorkflowRun(journal: InMemoryJournal, runId: string): Promise<string> {
  const gnl = createGnl({ journal, workflows: { w: { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) } } } as never);
  await gnl.runWorkflow!('w', {}, { runId, resourceId: 'u-ayse' } as never);
  return runId;
}

describe('kimlik-amaçlı :input ajan koşumu girdisi sayılmaz', () => {
  it('batch item id ile resumeRun REDDEDİLİR — ve ret adresli (batch der)', async () => {
    const journal = new InMemoryJournal();
    const runId = await seedBatchItem(journal);
    // Kimlik kaydı gerçekten orada (test yanlış sebepten yeşil yanmasın).
    expect(await journal.get(`${runId}:input`)).toBeDefined();

    await expect(resumeRun(runId, { journal, model: model(), tools: {} } as never))
      .rejects.toThrow(/batch/);

    // Sessiz düşmek yerine adresli ret: bu id'nin altına AJAN koşum kayıtları karışmadı.
    const keys = await journal.listKeys!(`${runId}:`);
    expect(keys.filter((k) => /:model:\d+$/.test(k)), 'ajan model adımı bu id\'nin altına yazıldı').toEqual([]);
    expect(keys).not.toContain(`${runId}:outcome`);
  });

  it('iş akışı id ile runDurable REDDEDİLİR — sessizce ilk-yazım gibi devam etmez', async () => {
    const journal = new InMemoryJournal();
    const runId = await seedWorkflowRun(journal, 'wf-ident-1');
    await expect(runDurable({ runId, journal, model: model(), prompt: 'merhaba' } as never))
      .rejects.toThrow(/workflow/);
    // `:input` claim'i zaten kayıtlı olduğu için kimlik kaydı EZİLEMEZ — iki tür kayıt tek anahtarda
    // yarışamaz, ve kimlik kaydı olduğu gibi kalır.
    const input = await journal.get<{ workflow?: string; prompt?: unknown }>(`${runId}:input`);
    expect(input?.workflow).toBe('w');
    expect(input?.prompt).toBeUndefined();
  });

  it('iş akışı id ile streamDurable REDDEDİLİR — unutulan hep yüzeyler', async () => {
    const journal = new InMemoryJournal();
    const runId = await seedWorkflowRun(journal, 'wf-ident-2');
    await expect(streamDurable({ runId, journal, model: model(), prompt: 'merhaba' } as never))
      .rejects.toThrow(/workflow/);
  });

  it('GERÇEK donmuş girdili koşumun resume\'u değişmeden çalışır', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'gercek-1', journal, model: model(), prompt: 'merhaba' } as never);
    const r = await resumeRun('gercek-1', { journal, model: model(), tools: {} } as never);
    expect(r.text).toBe('bitti');
  });

  it('prompt\'suz ama messages\'lı kayıt HÂLÂ benimsenir — ayırt edici iki yarımlı', async () => {
    // persistInput prompt VE messages alanlarını birlikte dondurur; `messages` ile başlatılan bir
    // koşumun kaydında prompt yoktur. Tek başına "prompt yok" ölçütü bu meşru şekli de reddederdi.
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'msg-1', journal, model: model(), messages: [{ role: 'user', content: 'merhaba' }] } as never);
    const frozen = await journal.get<{ prompt?: unknown; messages?: unknown }>('msg-1:input');
    expect(frozen?.prompt).toBeUndefined();
    expect(frozen?.messages).toBeDefined();
    const r = await resumeRun('msg-1', { journal, model: model(), tools: {} } as never);
    expect(r.text).toBe('bitti');
  });
});
