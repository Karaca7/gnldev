// SAHİPLİK KİLİDİ — Studio'nun resume ucu ile motorun actor kontrolü arasındaki halka.
//
// Motorda kilit zaten vardı (run.ts, RunActorMismatchError: damgalı bir koşumu FARKLI bir actor
// süremez) ama iki isim de dolu olmadan ateşlemiyor — ve Studio kendini hiç tanıtmadığı için
// kontrol HİÇ çalışmıyordu. Bu dosya iki şeyi sabitler:
//   1) Studio, host köprüsüne kendi kimliğini `ctx.actor` olarak veriyor.
//   2) Köprü bir çağıran-çatışması fırlattığında yanıt OKUNABİLİR: 409 + tipli kod + detay.
//
// (2) neden test edilmeye değer: canlıda ölçüldü — başkasının koşumunu onaylayan operatör
// `500 Internal Server Error` ve BOŞ gövde alıyordu; gerçek cümle yalnız sunucunun stderr'ine
// düşüyordu. Ret doğruydu, okunamıyordu. Okunamayan bir ret öğretmez; tekrar denenir.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, stampFormat, RunActorMismatchError, runKeys } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;

async function seedSuspend(journal: InMemoryJournal, runId: string, actor?: string) {
  const sentinel = { __gnl_suspend: { toolCallId: 'call-1', toolName: 'createOrder', args: { sku: 'A-1' }, reason: 'needs a human', kind: 'confirm' } };
  await journal.put(`${runId}:tool:call-1`, stampFormat({ status: 'suspended', output: sentinel, toolName: 'createOrder' }));
  // `:input` ŞART: runVisible bu kaydın varlığına bakıyor, yoksa uç 404 döner (ilk yazışta atlanmıştı).
  // `actor` alanı motorun sahiplik damgasının yaşadığı yer — burada da onu taşıyoruz ki fixture
  // gerçek bir damgalı koşumun şeklini temsil etsin.
  await journal.put(`${runId}:input`, stampFormat({ at: Date.now(), prompt: 'x', ...(actor ? { actor } : {}) }));
}

describe('resume: sahiplik kilidinin Studio tarafı', () => {
  it('Studio köprüye KENDİ kimliğini geçirir (kilit ancak iki isimle ateşler)', async () => {
    const journal = new InMemoryJournal();
    await seedSuspend(journal, 'r-1');
    let seen: { orgId?: string; actor?: string } | undefined;
    const api = drive(createStudioApi({
      reader: journal,
      resume: async (_runId, _approvals, ctx) => { seen = ctx; return { text: 'ok' }; },
    }));
    const res = await api(new Request('http://s/runs/r-1/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'call-1': true } }),
    }));
    expect(res.status).toBe(200);
    // Bu alan olmadan motorun kontrolü sessizce atlanır: `frozen.actor && opts.actor` şartı,
    // isimsiz tarafta HİÇ karşılaştırma yapmaz — yani damga vurulmuş olsa bile ret gelmez.
    //
    // Auth kurulmamış bir konsolda bu değer 'anon'dur ve öyle olması DOĞRU: Studio'nun kendi
    // (bilinmeyen) kimliğidir, çağıranın beyanı değil. İlk yazışta burada `x-gnl-actor` başlığı
    // kullanılmıştı — yani tam da kapatılan yol; test yeşil yanıyordu çünkü açığı sürüyordu.
    expect(seen?.actor).toBe('anon');
  });

  it('x-gnl-actor BAŞLIĞI yetkilendirmeye giremez — ret kendi kendine cevaplanamaz', async () => {
    // Başlık işbirlikçi bir atıf alanı (git author satırı gibi): kişi-başına auth kurmamış bir
    // konsol yine de "kim tıkladı" diyebilsin diye var. Denetim sütunu için doğru, KAPI için yanlış.
    // Kilit bu değeri okumaya başlayınca çağıran kendi reddini cevaplar hale geliyordu:
    // `409 belongs to actor 'ayse'` alan operatör isteği `x-gnl-actor: ayse` ile tekrarlıyor ve
    // 200 alıyordu. Açığın tamamı token-only kurulumlarda: roleAuth'un bearer kimlik bilgileri
    // bilerek `id` taşımaz, dolayısıyla orada kilidin karşılaştırdığı değer BAŞLIKTI.
    const journal = new InMemoryJournal();
    await seedSuspend(journal, 'r-4', 'ayse');
    let seen: { actor?: string } | undefined;
    const api = drive(createStudioApi({
      reader: journal,
      resume: async (_r, _a, ctx) => { seen = ctx; return { text: 'ok' }; },
    }));
    await api(new Request('http://s/runs/r-4/resume', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-gnl-actor': 'ayse' }, // kurbanın adını taklit
      body: JSON.stringify({ approvals: { 'call-1': true } }),
    }));
    expect(seen?.actor).not.toBe('ayse');
    // Rol yedeği KORUNUYOR ve yük taşıyor: 'anon'/'role:x' bir kullanıcı kimliği değildir ama hiçbir
    // resourceId ona eşit olmaz — yani kilit ateşlemeye devam eder. undefined dönmek kilidi
    // tamamen susturur ve kapatılan deliği geri açardı.
    expect(seen?.actor).toBeTruthy();
  });

  it('çağıran-çatışması 409 + tipli kod döner (500 + boş gövde DEĞİL)', async () => {
    const journal = new InMemoryJournal();
    await seedSuspend(journal, 'r-2', 'ayse');
    const api = drive(createStudioApi({
      reader: journal,
      resume: async () => {
        throw new RunActorMismatchError(
          "@gnldev/durable: run 'r-2' belongs to actor 'ayse' — 'operator-7' may not re-drive it.",
          { runId: 'r-2', ownerActor: 'ayse', requestedActor: 'operator-7' },
        );
      },
    }));
    const res = await api(new Request('http://s/runs/r-2/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'call-1': true } }),
    }));
    expect(res.status).toBe(409); // @gnldev/server'ın çağıran-çatışması taksonomisiyle AYNI — tek sözlük
    const body = await res.json() as { error: string; code: string; detail?: { ownerActor?: string } };
    expect(body.code).toBe('run_actor_mismatch');
    expect(body.error).toContain('belongs to actor');
    expect(body.detail?.ownerActor).toBe('ayse'); // sahibi KİM — ret okunabilir olsun diye
  });

  it('audit GERÇEK kararı yazar, istenen kararı değil', async () => {
    // Motor first-decision-wins: journalda kayıtlı bir `true` varken `false` taşıyan bir istek
    // çağrıyı ÇALIŞTIRIR. Audit isteneni yazsaydı satır "deny" derdi ve motorun yaptığının tersini
    // söylerdi. Motorun yaptığını yanlış anlatan bir denetim kaydı, kayıt yokluğundan daha kötüdür:
    // yanlış tanıktır.
    const journal = new InMemoryJournal();
    await seedSuspend(journal, 'r-5');
    await journal.put(runKeys.approval('r-5', 'call-1'), { v: 1, decision: true, at: Date.now() });
    await journal.put(runKeys.tool('r-5', 'call-1'), { status: 'succeeded' }); // iş çoktan oldu
    const api = drive(createStudioApi({ reader: journal, resume: async () => ({ text: 'ok' }) }));
    await api(new Request('http://s/runs/r-5/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'call-1': false } }), // istenen: ret
    }));
    const audit = await (await api(new Request('http://s/audit'))).json() as { items: Array<{ action: string; detail?: any }> };
    const row = audit.items.find((i) => i.action === 'approve' || i.action === 'deny');
    expect(row?.action).toBe('approve');                    // motor ne yaptıysa o
    expect(row?.detail?.approvals?.['call-1']).toBe(true);
    expect(row?.detail?.requested?.['call-1']).toBe(false); // ve istenen de KAYBOLMUYOR
  });

  it('tipsiz hata: motorun cümlesi gövdeye çıkar ama 5xx KALIR', async () => {
    // Replay giriş-noktası reddi düz bir Error (tipli kodu yok). Mesajı göstermek gerekiyor —
    // ama sınıflandırılmamış bir arızayı temiz bir istemci hatası gibi göstermek yanlış olurdu.
    const journal = new InMemoryJournal();
    await seedSuspend(journal, 'r-3');
    const api = drive(createStudioApi({
      reader: journal,
      resume: async () => { throw new Error('replay entry-point mismatch: expected generate, found stream'); },
    }));
    const res = await api(new Request('http://s/runs/r-3/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'call-1': true } }),
    }));
    expect(res.status).toBe(500);
    expect((await res.json() as { error: string }).error).toContain('entry-point mismatch');
  });
});
