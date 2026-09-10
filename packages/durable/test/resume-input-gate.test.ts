// POLİTİKA KAPISI, YAN ETKİNİN KOŞTUĞU TURDA AÇIK KALIYORDU.
//
// Girdi işlemcileri `persistInput`'tan ÖNCE koşar ve dönüştürdükleri girdi journal'a donar. Resume
// turunda `applyInputProcessors` donmuş girdiyi benimseyip zinciri hiç çağırmadan dönüyordu. Bu,
// DÖNÜŞÜM için doğru — maskeleme ikinci kez uygulanmamalı. Ama aynı kanca politika kapısı olarak da
// kullanılıyor: `ProcessorTripwire` fırlatan moderasyon/enjeksiyon işlemcisi resume turunda hiç
// çağrılmıyordu.
//
// Ölçülen: kullanıcı 1. turdan sonra bloklandı; onay turunda tripwire çalışmadı, ödeme geçti. Yani
// kapı tam da yan etkinin gerçekleştiği turda atıldı. Adım-arası kanca için zaten verilmiş karar
// aynen geçerli: "fail-open bir yönetişim kancası, hiç kanca olmamasından kötüdür."
//
// AYRIM: resume turunda zincir GEÇİT KİPİNDE koşar — dönüş değeri ATILIR, yalnız fırlatma taşınır.
// Böylece maskeleme iki kez uygulanmaz ama kapı kapanır.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { ProcessorTripwire } from '../src/processor.js';
import type { Processor } from '../src/processor.js';
import { countToolResults, toolCallResult, finalTextResult, createMockModel } from './mock.js';

const TCID = 'call-ode';

/**
 * Bir onay kapısına çarpan koşum: model bir kez ödeme aracını çağırır, sonra biter.
 *
 * `extra.body` gövdeyi değiştirir (varsayılan `prompt`; `messages` isteyen testler için),
 * `extra.seen` modelin GERÇEKTEN gördüğü prompt'ları toplar — "geçit ne yaptı" sorusunun cevabı
 * işlemcinin dönüş değerinde değil, modele giden metindedir.
 */
function payRun(
  journal: InMemoryJournal,
  processors: Processor[],
  charges: { n: number },
  approvals?: Record<string, boolean>,
  runId = 'rg-1',
  extra?: { body?: Record<string, unknown>; seen?: unknown[] },
) {
  return runDurable({
    runId,
    journal,
    processors,
    stopWhen: stepCountIs(4),
    ...(extra?.body ?? { prompt: 'ödemeyi yap' }),
    ...(approvals ? { approvals } : {}),
    model: createMockModel(async ({ prompt }: any) => {
      extra?.seen?.push(prompt);
      return countToolResults(prompt) === 0 ? toolCallResult('paraGonder', TCID, { tutar: 500 }) : finalTextResult('bitti');
    }),
    tools: {
      paraGonder: { sideEffect: true, confirm: true as const, execute: async () => { charges.n++; return { ok: true }; } },
    },
  } as never);
}

describe('resume turunda girdi kapısı', () => {
  it('1. turdan SONRA bloklanan kullanıcının onay turu tripwire ile durur — yan etki koşmaz', async () => {
    const journal = new InMemoryJournal();
    const charges = { n: 0 };
    let banned = false;
    const moderation: Processor = {
      name: 'moderasyon',
      processInput: (i) => {
        if (banned) throw new ProcessorTripwire('kullanıcı bloklandı', 'moderasyon');
        return i;
      },
    };

    const r1 = await payRun(journal, [moderation], charges);
    expect(r1.interrupts.length, 'onay kapısı hiç çalmadı — senaryo kurulamadı').toBeGreaterThan(0);
    expect(charges.n).toBe(0);

    banned = true; // iki tur arasında kullanıcı bloklandı
    await expect(payRun(journal, [moderation], charges, { [TCID]: true }))
      .rejects.toBeInstanceOf(ProcessorTripwire);
    expect(charges.n, 'kapı atıldı ve para gitti').toBe(0);
  });

  it('DÖNÜŞÜM ikinci kez uygulanmaz — geçit kipinin dönüş değeri atılır', async () => {
    // Asıl gerilim bu. Kapıyı kapatmanın bedeli maskelemeyi iki kez uygulamak olsaydı, çare
    // hastalıktan kötü olurdu: journal'daki donmuş girdi tek gerçek kaynağı olarak kalmalı.
    //
    // ASKI SAHNESİ, bilerek. İlk hâli BİTMİŞ bir koşumun replayi üstünde ölçüyordu — orada zincir
    // bitmiş-koşum muafiyeti yüzünden hiç çağrılmıyor (bkz. rg-7), yani test yeşil kalırken hiçbir
    // şey ölçmüyordu. Geçidin gerçekten koştuğu tek sahne askıdaki koşumdur.
    const journal = new InMemoryJournal();
    const suffix: Processor = {
      name: 'ek',
      processInput: (i) => ({ ...i, prompt: typeof i.prompt === 'string' ? `${i.prompt}!` : i.prompt }),
    };
    const seen: unknown[] = [];

    const r1 = await payRun(journal, [suffix], { n: 0 }, undefined, 'rg-2');
    expect(r1.interrupts.length, 'askı sahnesi kurulamadı — geçit hiç koşmayacaktı').toBeGreaterThan(0);
    expect((await journal.get<any>('rg-2:input')).prompt).toBe('ödemeyi yap!');

    await payRun(journal, [suffix], { n: 0 }, { [TCID]: true }, 'rg-2', { seen });
    // Donmuş girdi attempt-1'deki hâliyle duruyor: geçit koştu, dönüş değeri atıldı.
    expect((await journal.get<any>('rg-2:input')).prompt, 'ek ikinci kez uygulandı').toBe('ödemeyi yap!');
    // Ve modele giden metinde de iki ünlem yok — dönüşüm gerçekten üst üste binmedi.
    expect(JSON.stringify(seen)).not.toContain('ödemeyi yap!!');
  });

  it('geçit, modelin GERÇEKTEN göreceği girdiyi görür — çağıranın ham argümanlarını değil', async () => {
    // Resume'da çağıranın gövdesi atılıyor ve donmuş girdi benimseniyor. Kapı ham gövdeyi
    // denetleseydi, donmuş metni hiç görmeden karar vermiş olurdu — yanlış şeyi onaylayan bir kapı.
    // Askıdaki bir koşumla ölçülüyor: geçidin sahnesi bitmemiş koşumdur (bkz. rg-7).
    const journal = new InMemoryJournal();
    const seen: unknown[] = [];
    const spy: Processor = {
      name: 'gozcu',
      processInput: (i, ctx) => { if (ctx.resume) seen.push(i.prompt); return { ...i, prompt: 'DONMUŞ' }; },
    };
    await payRun(journal, [spy], { n: 0 }, undefined, 'rg-3'); // askıya girer
    await payRun(journal, [spy], { n: 0 }, { [TCID]: true }, 'rg-3'); // onay turu — geçit koşar
    expect(seen).toEqual(['DONMUŞ']);
  });

  it('geçit kipi KENDİNİ tanıtır — pahalı işi tekrarlamak istemeyen işlemci erken dönebilir', async () => {
    const journal = new InMemoryJournal();
    let gatePasses = 0;
    const p: Processor = { name: 'p', processInput: (i, ctx) => { if (ctx.resume) gatePasses++; return i; } };
    await payRun(journal, [p], { n: 0 }, undefined, 'rg-4');
    expect(gatePasses).toBe(0); // ilk tur geçit değil
    await payRun(journal, [p], { n: 0 }, { [TCID]: true }, 'rg-4');
    expect(gatePasses).toBe(1);
  });

  it('resumeGate: false diyen işlemci resume turunda ÇAĞRILMAZ', async () => {
    // Sözleşmeyi tutamayan bir işlemci (dışarıya çağrı yapan, tekrarlanamaz) açıkça çıkabilmeli.
    // Varsayılan AÇIK, çünkü sessizce atıl kalan bir kapı bulunması en zor arızadır.
    const journal = new InMemoryJournal();
    let calls = 0;
    const p: Processor = { name: 'p', resumeGate: false, processInput: (i) => ((calls++), i) };
    await payRun(journal, [p], { n: 0 }, undefined, 'rg-5'); // askıya girer — geçidin koşacağı sahne
    await payRun(journal, [p], { n: 0 }, { [TCID]: true }, 'rg-5');
    expect(calls).toBe(1);
  });

  it('BİTMİŞ koşumun replayi geçitten muaf — tamamlanmış defter kaydı ezilmez', async () => {
    // Fable denetiminde yakalandı: geçit ilk hâliyle TAMAMLANMIŞ koşumun yeniden teslimi
    // (at-least-once kuyruk, istemci retry'ı) üzerinde de koşuyordu. Replay taze iş yapmaz — model
    // çağrılmaz, araç koşmaz — yani orada fırlatmak hiçbir şeyi korumuyor; ama dış catch'e düşen
    // fırlatma, zamana-göre-monoton outcome yazımıyla kurbanın 'completed' kaydını 'failed' ile
    // eziyordu. Ölçüldü: SONUÇ ÖNCE completed → REPLAY ProcessorTripwire → SONUÇ SONRA failed.
    // İş yapılmıştı; kayıt yalan söylüyordu. assertThreadOwnership'in runStarted önüne alınmasıyla
    // birebir aynı bozulma sınıfı.
    const journal = new InMemoryJournal();
    let banned = false;
    const mod: Processor = {
      name: 'moderasyon',
      processInput: (i) => { if (banned) throw new ProcessorTripwire('bloklandı', 'moderasyon'); return i; },
    };
    const model = () => createMockModel(async () => finalTextResult('tamam'));

    const r1 = await runDurable({ runId: 'rg-7', journal, model: model(), processors: [mod], stopWhen: stepCountIs(4), prompt: 'x' } as never);
    expect(r1.text).toBe('tamam');

    banned = true; // politika değişti; sonra kuyruk aynı işi yeniden teslim etti
    const r2 = await runDurable({ runId: 'rg-7', journal, model: model(), processors: [mod], stopWhen: stepCountIs(4), prompt: 'x' } as never);
    expect(r2.text, 'replay kayıtlı cevabı vermeli').toBe('tamam');
    const outcome = await journal.get<{ status?: string }>('rg-7:outcome');
    expect(outcome?.status, 'bitmiş koşumun kaydı failed ile ezildi').toBe('completed');
  });

  it('FAILED koşumun retryı muaf DEĞİL — o taze iş yapar, geçit koşar', async () => {
    // Muafiyetin sınırı "bitmiş" olmak, "daha önce denenmiş" olmak değil. failed bir koşumun
    // retry'ı modeli yeniden çağırır ve araç koşturabilir — kapı tam orada gerekli.
    const journal = new InMemoryJournal();
    let banned = false;
    let attempt = 0;
    const mod: Processor = {
      name: 'moderasyon',
      processInput: (i) => { if (banned) throw new ProcessorTripwire('bloklandı', 'moderasyon'); return i; },
    };
    const model = () => createMockModel(async () => {
      if (++attempt === 1) throw new Error('sağlayıcı düştü');
      return finalTextResult('tamam');
    });
    await expect(runDurable({ runId: 'rg-8', journal, model: model(), processors: [mod], stopWhen: stepCountIs(4), prompt: 'x' } as never))
      .rejects.toThrow('sağlayıcı düştü');

    banned = true;
    await expect(runDurable({ runId: 'rg-8', journal, model: model(), processors: [mod], stopWhen: stepCountIs(4), prompt: 'x' } as never))
      .rejects.toBeInstanceOf(ProcessorTripwire);
  });

  it('geçit girdiyi YERİNDE değiştiremez — donmuş thread’e ekleme modele gitmez', async () => {
    // Geçide verilen `messages` dizisi, modele gidecek dizinin CANLI referansıydı. Dönüş değerini
    // atmak bir işlemciyi durdurmuyor: `input.messages.push(...)` yazan üçüncü parti bir işlemci
    // donmuş girdinin üstüne her resume'da bir kez daha yazıyor ve o metin modele gidiyordu —
    // "dönüşüm ikinci kez uygulanmaz" vaadinin arka kapısı.
    const journal = new InMemoryJournal();
    const seen: unknown[] = [];
    const pushy: Processor = {
      name: 'ekleyici',
      // Yalnız geçit turunda: 1. turda eklemek meşru bir dönüşüm olurdu ve donmuş girdiye girerdi.
      processInput: (i, ctx) => {
        if (ctx.resume && Array.isArray(i.messages)) i.messages.push({ role: 'user', content: 'EKLENDI' });
        return i;
      },
    };
    const body = { messages: [{ role: 'user', content: 'ödemeyi yap' }] };

    await payRun(journal, [pushy], { n: 0 }, undefined, 'rg-9', { body }); // askıya girer
    await payRun(journal, [pushy], { n: 0 }, { [TCID]: true }, 'rg-9', { body, seen });

    expect(seen.length, 'onay turunda model hiç çağrılmadı — ölçüm kurulamadı').toBeGreaterThan(0);
    expect(JSON.stringify(seen), 'geçitteki yerinde ekleme modele gitti').not.toContain('EKLENDI');
  });

  it('ctx.step geçit turunda YENİDEN HESAPLAMAZ — journal’daki karar okunur', async () => {
    // Kapıyı kapatmak, her resume’da bir model çağrısı daha demek olmamalı. `ctx.step` sözleşmesi
    // ("resume’da aynı karar") burada da geçerli: karar kayıtlıysa tekrar hesaplanmaz. Askıdaki
    // koşumla ölçülüyor ki geçit GERÇEKTEN koşsun — bitmiş koşumda zaten hiç çağrılmıyor.
    const journal = new InMemoryJournal();
    let computes = 0;
    const p: Processor = {
      name: 'yargic',
      processInput: async (i, ctx) => { await ctx.step('karar', () => `k-${++computes}`); return i; },
    };
    await payRun(journal, [p], { n: 0 }, undefined, 'rg-6');
    await payRun(journal, [p], { n: 0 }, { [TCID]: true }, 'rg-6');
    expect(computes).toBe(1);
  });
});
