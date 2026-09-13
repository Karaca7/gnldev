// TÜRETİLMİŞ BİR İŞ AKIŞI KİMLİĞİ, PROFİLDEN BAĞIMSIZ OLARAK BİR SÖZ VERİR.
//
// `run`/`stream` yolunda paket #3'ün kurduğu kural şuydu: id'yi motor bir workKey'den bastıysa
// (`run1_…`), o id artık çağıranın uydurduğu bir ad değil — kimin işi olduğu ve işin ne olduğu
// hakkında bir iddia. `assertRunAdmissible` bu yüzden sahiplik ve girdi parmak izini `strictInput`
// bayrağına DEĞİL, `isDerivedRunId`'ye bağlar.
//
// İş akışı kapısı o kuralı almamıştı. Üç kontrolü de vardı — mezar taşı, girdi parmak izi, kilit —
// ama hepsi `preset === 'critical'` bloğunun İÇİNDE. Yani ölçülen davranış: aynı workKey, aynı org,
// FARKLI kullanıcı → aynı `run1_` id'sinde buluşuyorlar, ikincisi birincinin adımlarını devralıyor
// ve hiçbir şey itiraz etmiyor. Profil `balanced` olduğu için. Oysa türetilmiş id'yi çağıran
// istemedi, motor bastı: motorun kendi bastığı ada verdiği sözü profil bayrağına bağlaması,
// "koruma açık mı?" sorusunu vaadin kendisiyle ilgisiz bir yere taşır.
//
// HAM runId'de hiçbir şey değişmez ve bu testler bunu da mühürlüyor: ham id çağıranın kendi anahtarı,
// motor onun hakkında bir vaatte bulunmadı, `critical` dışında sorgulanmaz.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { derivedRunId } from '../src/hash.js';
import { RunSweptError, RunInputMismatchError, RunOwnerMismatchError } from '../src/errors.js';

/**
 * Adımını journal'dan tekrar oynatan asgari iş akışı (workkey-gate.test.ts'teki kardeşiyle aynı
 * şekil). Sayaç ÇAĞRIYI değil GERÇEKTEN YAPILAN İŞİ ölçsün diye böyle: bu dosyanın her iddiası
 * "adım koştu mu" üstünde, "fonksiyon çağrıldı mı" üstünde değil.
 */
function countingWorkflow(runs: { n: number }) {
  return {
    build: () => [{ id: 's1' }],
    run: async (input: unknown, ctx: { runId: string; journal: InMemoryJournal }) => {
      const key = `${ctx.runId}:wf:s1`;
      const existing = await ctx.journal.get(key);
      if (existing !== undefined) return existing;
      runs.n++;
      const out = { ok: true, input };
      await ctx.journal.put(key, out);
      return out;
    },
  };
}

const ORG = 'org-akme';

describe('runWorkflow — türetilmiş id, profilden bağımsız kapı', () => {
  it('MEZAR TAŞI: süpürülmüş türetilmiş bir koşumun geç denemesi reddedilir (preset yok)', async () => {
    const journal = new InMemoryJournal();
    const runs = { n: 0 };
    const gnl = createGnl({ journal, workflows: { mutabakat: countingWorkflow(runs) as never } });
    const id = derivedRunId('wf:mutabakat', 'org', ORG, 'gece-mutabakati-2026-09-11');
    // Retention'ın bıraktığı iz: koşum silindi, dedup penceresi onunla birlikte öldü.
    await journal.put(`${id}:swept`, { at: Date.now(), workScope: 'org' });
    await expect(
      gnl.runWorkflow('mutabakat', { gun: '2026-09-11' }, {
        workKey: 'gece-mutabakati-2026-09-11', workScope: 'org', context: { __gnl_orgId: ORG },
      } as never),
    ).rejects.toBeInstanceOf(RunSweptError);
    expect(runs.n, 'adım hiç koşmadı — reddedilen bir ad iş yapamaz').toBe(0);
  });

  it('SAHİPLİK: org kapsamında aynı workKey iki özneyi aynı id\'de buluşturur; ikincisi reddedilir', async () => {
    // `workScope: 'org'` id'yi org adresine bağlar — Ayşe ile Mehmet AYNI `run1_` id'sini hesaplar.
    // Kapı olmadan Mehmet'in çağrısı Ayşe'nin koşumunu devralıyordu, sessizce.
    const journal = new InMemoryJournal();
    const runs = { n: 0 };
    const gnl = createGnl({ journal, workflows: { rapor: countingWorkflow(runs) as never } });
    const opts = (who: string) => ({
      workKey: 'ceyreklik-rapor', workScope: 'org' as const,
      context: { __gnl_orgId: ORG, __gnl_resourceId: who },
    });
    const r1 = await gnl.runWorkflow('rapor', { q: 3 }, opts('u-ayse') as never);
    expect((await journal.get<{ resourceId?: string }>(runKeys.input(r1.runId)))?.resourceId).toBe('u-ayse');
    await expect(
      gnl.runWorkflow('rapor', { q: 3 }, opts('u-mehmet') as never),
    ).rejects.toBeInstanceOf(RunOwnerMismatchError);
    expect(runs.n).toBe(1);
  });

  it('GİRDİ PARMAK İZİ: aynı ad + aynı özne, FARKLI girdi → 409 (preset yok)', async () => {
    const journal = new InMemoryJournal();
    const runs = { n: 0 };
    const gnl = createGnl({ journal, workflows: { fatura: countingWorkflow(runs) as never } });
    const opts = { workKey: 'fatura-4471', resourceId: 'u-ayse' };
    await gnl.runWorkflow('fatura', { tutar: 100 }, opts as never);
    await expect(
      gnl.runWorkflow('fatura', { tutar: 999 }, opts as never),
    ).rejects.toBeInstanceOf(RunInputMismatchError);
    expect(runs.n, 'ikinci girdi hiç koşmadı').toBe(1);
    // …ve AYNI girdinin tekrarı hâlâ sessizce tekrar oynar: kapı yeniden denemeyi cezalandırmıyor.
    await gnl.runWorkflow('fatura', { tutar: 100 }, opts as never);
    expect(runs.n).toBe(1);
  });

  it('HAM runId hiçbirinden etkilenmez — motor onun hakkında bir söz vermedi', async () => {
    const journal = new InMemoryJournal();
    const runs = { n: 0 };
    const gnl = createGnl({ journal, workflows: { w: countingWorkflow(runs) as never } });
    await journal.put('ham-1:swept', { at: Date.now() });
    // Mezar taşı: ham id'de `tombstonePolicy` yok, koşum geçer.
    await gnl.runWorkflow('w', { a: 1 }, { runId: 'ham-1' } as never);
    // Sahiplik: ilk çağrı Ayşe'nin, ikincisi Mehmet'in — ham id'de devir hâlâ yasal.
    await gnl.runWorkflow('w', { a: 1 }, { runId: 'ham-2', resourceId: 'u-ayse' } as never);
    await gnl.runWorkflow('w', { a: 1 }, { runId: 'ham-2', resourceId: 'u-mehmet' } as never);
    // Girdi: ham id'de parmak izi opt-in, farklı girdi geçer.
    await gnl.runWorkflow('w', { a: 2 }, { runId: 'ham-2' } as never);
    expect(runs.n, 'ham-1 bir kez; ham-2 journal replay ettiği için bir kez').toBe(2);
  });
});
