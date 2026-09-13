// TANIMI OLAN AMA DURUMU OLMAYAN TETİK: SONSUZA DEK GÖRÜNMEZ.
//
// `scheduleWorkflow` bir tetiği kaydederken TEK bir soru soruyordu: "`sched:def:<id>` var mı?".
// Varsa hiçbir şey yapmıyordu — kaydın DİĞER YARISINA, `sched:state:<id>`'ye hiç bakmadan. İkisi
// birlikte yazıldığı için bu, doğduğu gün doğru bir kısayoldu. Ama durum kaydı SONRADAN kaybolabilir
// (yanlış kapsamlı bir purge, bir saklama süpürmesi, elle temizlik), ve o an tetik şu hale gelir:
//
//   • `pollScheduler` onu atlar — `!state` dalı, sessizce (index.ts, def/state okuması).
//   • `listTriggers` onu listeye bile koymaz — "tutarsız/kısmi kayıt" diye atlar, yani Studio'da YOK.
//   • Uygulama her açılışta `scheduleWorkflow`'u yeniden çağırır, o da "def zaten var" deyip döner.
//
// Üçü birlikte: tetik ne çalışır, ne görünür, ne de onarılır. Canlıda yaşandı; teşhis, bir işin neden
// yapılmadığının fark edilmesiyle başladı, çünkü şikâyet edecek bir kayıt yoktu.
//
// ONARIM, ve neden `scheduleWorkflow`: burası spec'in ELDE OLDUĞU tek yer. `at | every | cron` ve
// `firstRunAt` olmadan "bir sonraki koşum ne zaman" sorusunun cevabı yok. Uygulamalar bu çağrıyı
// zaten her açılışta yapıyor (idempotent kayıt sözü), yani onarımın tetikleyicisi de hazır.
//
// SESSİZ DEĞİL: onarım bir console.warn basar. Kendiliğinden düzelen ve kimseye söylemeyen bir sistem,
// aynı silmeyi her hafta yapan bir işlemi asla göstermez.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { scheduleWorkflow, pollScheduler, listTriggers, type WorkflowRunner } from '../src/index.js';

function mockRunner(): WorkflowRunner & { calls: { name: string; runId: string }[] } {
  const calls: { name: string; runId: string }[] = [];
  return {
    calls,
    async runWorkflow(name, _input, opts) {
      const runId = opts?.runId ?? 'x';
      calls.push({ name, runId });
      return { runId, output: 'ok' };
    },
  };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('scheduleWorkflow — yetim durum onarımı', () => {
  it('def VAR, state YOK → durum yeniden doğar, tetik tekrar ateşlenebilir hale gelir', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 't', name: 'wf', every: 60_000 }, 0);
    // Durum kaydı kaybolur (yanlış kapsamlı bir temizlik).
    await j.deletePrefix('sched:state:t'); // durum kaydı kaybolur
    expect(await listTriggers(j)).toEqual([]); // görünmez: onarımın önündeki asıl mesele bu

    await scheduleWorkflow(j, { id: 't', name: 'wf', every: 60_000 }, 100_000);

    expect(await j.get('sched:state:t')).toEqual({ nextRunAt: 160_000, attempts: 0, fireCount: 0, status: 'pending' });
    const listed = await listTriggers(j);
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: 't', status: 'pending', nextRunAt: 160_000 });

    const runner = mockRunner();
    expect((await pollScheduler(j, runner, 160_000)).fired).toBe(1);
  });

  it('onarım SESSİZ DEĞİL', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 't', name: 'wf', at: 5_000 }, 0);
    await j.deletePrefix('sched:state:t'); // durum kaydı kaybolur
    await scheduleWorkflow(j, { id: 't', name: 'wf', at: 5_000 }, 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('orphaned trigger state repaired');
    expect(String(warn.mock.calls[0]![0])).toContain('t');
  });

  it('def + state İKİSİ DE varsa hiçbir şey yazılmaz (bugünkü davranış aynen)', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 't', name: 'wf', every: 60_000 }, 0);
    const before = await j.get('sched:state:t');

    const put = vi.spyOn(j, 'put');
    const id = await scheduleWorkflow(j, { id: 't', name: 'wf', every: 999 }, 500_000);

    expect(id).toBe('t');
    expect(put).not.toHaveBeenCalled(); // ne def, ne state — tanım hâlâ değişmez
    expect(await j.get('sched:state:t')).toEqual(before);
    expect(warn).not.toHaveBeenCalled();
    put.mockRestore();
  });

  it('yeni bir tetikte tek satır bile değişmez (onarım yolu yalnız yetimi görür)', async () => {
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 'yeni', name: 'wf', at: 1_000 }, 0);
    expect(await j.get('sched:state:yeni')).toEqual({ nextRunAt: 1_000, attempts: 0, fireCount: 0, status: 'pending' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('onarılan sayaç, ESKİ koşum id’lerinin üstüne oturmaz', async () => {
    // fireCount runId'nin bir parçası (`sched:<id>:<fireCount>`) ve durable koşum tam olarak bu id
    // üzerinden exactly-once. Sıfırdan başlayan bir onarım, ilk ateşlemede zaten TAMAMLANMIŞ bir
    // koşumu yeniden adresler: motor kayıttan cevabı döndürür, iş yapılmaz, sayaç ilerler. Tetik
    // "çalışıyor" görünür ve hiçbir şey olmaz — düzeltmek istediğimiz sessizliğin aynısı.
    const j = new InMemoryJournal();
    await scheduleWorkflow(j, { id: 't', name: 'wf', every: 1_000 }, 0);
    const runner = mockRunner();
    await pollScheduler(j, runner, 1_000); // sched:t:0
    await pollScheduler(j, runner, 2_000); // sched:t:1
    expect(runner.calls.map((c) => c.runId)).toEqual(['sched:t:0', 'sched:t:1']);

    await j.deletePrefix('sched:state:t'); // durum kaydı kaybolur
    await scheduleWorkflow(j, { id: 't', name: 'wf', every: 1_000 }, 10_000);

    const repaired = await j.get<{ fireCount: number }>('sched:state:t');
    expect(repaired!.fireCount).toBe(2); // 0 ve 1 kullanıldı; sıra 2'de
    const runner2 = mockRunner();
    await pollScheduler(j, runner2, 11_000);
    expect(runner2.calls[0]!.runId).toBe('sched:t:2');
  });
});
