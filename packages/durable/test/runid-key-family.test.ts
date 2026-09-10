// runId BİR ANAHTAR ÖNEKİDİR — ve doğrulanmayan tek tanımlayıcıydı.
//
// `resourceId`, `batchId`, `itemKey`, `orgId` hepsinin kontrolü var; runId'nin yoktu. Oysa runId
// journal anahtarlarının önekidir (`<runId>:model:0`, `<runId>:tool:<id>`, `<runId>:input`) ve
// `purgeRun` tam olarak o önekle siler (`retention.ts`, `del(runId + ':')`).
//
// ÖLÇÜLDÜ: `runId: 'mem'` ile bir koşum açıldı, sonraki retention süpürmesi `del('mem:')` yaptı ve
// KURBAN bir thread'in mesajları silindi. Saldırı ucuz, etki toptan, sonuç geri alınamaz.
//
// Doğrulama MOTORDA duruyor, HTTP yüzeylerinde değil — çünkü unutulan hep yüzeyler: chat-adapter,
// agui, batch, CLI ve her host rotası doğrudan runDurable'a iniyor.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, resumeRun, assertRunIdSafe } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

const run = (journal: InMemoryJournal, runId: string) =>
  runDurable({ runId, journal, model: createMockModel(async () => finalTextResult('ok')), prompt: 'x' } as any);

describe('runId anahtar ailesi koruması', () => {
  it('journalın SAHİP OLDUĞU aileleri runId olarak almaz', async () => {
    const journal = new InMemoryJournal();
    for (const bad of ['mem', 'xthr', 'xid', 'thread', 'om', 'lesson', 'sugg', 'org', 'res', 'xrun']) {
      await expect(run(journal, bad)).rejects.toThrow(/reserved key family/);
      // Alt anahtarla gelen hali de aynı: 'mem:kurban' süpürmesi yine 'mem:' altını siler.
      await expect(run(journal, `${bad}:kurban`)).rejects.toThrow(/reserved key family/);
    }
  });

  it('çift alt çizgili iç aileler de kapalı (__audit__, __budget__, __metrics__ …)', async () => {
    await expect(run(new InMemoryJournal(), '__audit__')).rejects.toThrow(/reserved key family/);
  });

  it('MOTORUN KENDİ bileşik idleri geçer — onların öneki gerçekten kendilerinin', async () => {
    // batch:/sched:/net:/agent:/wfrun: motor tarafından KURULUYOR. Bunları reddetmek, çalışan
    // batch ve scheduler yollarını kırardı — düzeltmenin amacı bu değil.
    const journal = new InMemoryJournal();
    for (const ok of ['batch:aylik:F-1', 'sched:saglik:0', 'net:r1:node', 'agent:r1:call-1', 'wfrun:w1']) {
      await expect(run(journal, ok)).resolves.toBeTruthy();
    }
  });

  it('mevcut kurulumların idleri aynen çalışır — karakter beyaz listesi YOK', async () => {
    // Bilerek dar: sahada UUIDler, `chat-<ms>-<n>`, elle yazılmış idler koşuyor. Katı bir desen
    // zaten journalda duran işi reddederdi. Kural "bir aileyi SAHİPLENME"dir, "şu harfleri kullan" değil.
    const journal = new InMemoryJournal();
    for (const ok of ['9f1c2a44-1f2e-4a77-9c11-2b0d1e9a77aa', 'chat-1788894496454-1', 'siparis_42', 'memo-1']) {
      await expect(run(journal, ok)).resolves.toBeTruthy();
    }
  });

  it('boşluk/kontrol karakteri ve boş id reddedilir', async () => {
    const journal = new InMemoryJournal();
    await expect(run(journal, '')).rejects.toThrow(/non-empty/);
    await expect(run(journal, 'a b')).rejects.toThrow(/whitespace or control/);
    await expect(run(journal, 'a\nb')).rejects.toThrow(/whitespace or control/);
  });

  it('resumeRun da JOURNALA DOKUNMADAN reddeder', async () => {
    // Erken olması önemli: reddedilen bir aileyle okuma yapmak bile onu meşrulaştırır gibi görünür.
    const journal = new InMemoryJournal();
    let read = 0;
    const spy = new Proxy(journal, { get: (t, k) => (k === 'get' ? (...a: any[]) => { read++; return (t as any).get(...a); } : (t as any)[k]) });
    await expect(resumeRun('mem', { journal: spy as any, model: createMockModel(async () => finalTextResult('ok')) } as any))
      .rejects.toThrow(/reserved key family/);
    expect(read).toBe(0);
  });

  it('assertRunIdSafe dışa açık — hostlar aynı kuralı kendi ucunda uygulayabilsin', () => {
    expect(() => assertRunIdSafe('mem')).toThrow();
    expect(() => assertRunIdSafe('ok-1')).not.toThrow();
  });
});
