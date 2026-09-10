// ONAY KAYDI: imzalı ve durumlu.
//
// Kapatılan somut arıza (ölçüldü, saldırgan YOK): operatör Onayla'ya bastı → tur çöktü → operatör
// Reddet'e bastı → YAN ETKİ ÇALIŞTI. Sebep: karar çıplak bir `true` idi ve "ilk karar kazanır"
// kuralı, işi henüz YAPILMAMIŞ bir onayı da yenilemez kılıyordu. Kayıt `suspended` kaldığı için
// gelen kutusu ikinci tıkı davet ediyordu.
//
// Çizilen sınır SAAT değil, ETKİ: bir karar, cevapladığı çağrı terminal hale gelene kadar
// değiştirilebilir. Terminal olduktan sonra karar geçmiştir; onu değiştirmek bir sonucu yeniden
// yazmak olur, yönlendirmek değil.
//
// "Kim cevapladı" sorusu da aynı kayda giriyor: imzasız bir karar ne denetlenebilir ne de
// precision@suspend'de operatör tıkından ayrılabilir.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { resolveApprovals, decisionOf, type ApprovalRecord } from '../src/run.js';
import { runKeys } from '../src/journal.js';

const KEY = (r: string, t: string) => runKeys.approval(r, t);

describe('onay kaydı — imza', () => {
  it('karar KİM ve NE ZAMAN ile birlikte yazılır', async () => {
    const j = new InMemoryJournal();
    await resolveApprovals(j, 'r1', { 'call-1': true }, { actor: 'ayse' });
    const rec = await j.get<ApprovalRecord>(KEY('r1', 'call-1'));
    expect(rec?.v).toBe(1);
    expect(rec?.decision).toBe(true);
    expect(rec?.actor).toBe('ayse');
    expect(typeof rec?.at).toBe('number');
  });

  it('aktör bilinmiyorsa alan HİÇ yazılmaz — boş bir imza uydurulmaz', async () => {
    const j = new InMemoryJournal();
    await resolveApprovals(j, 'r2', { 'call-1': false });
    const rec = await j.get<ApprovalRecord>(KEY('r2', 'call-1'));
    expect(rec?.decision).toBe(false);
    expect('actor' in (rec ?? {})).toBe(false);
  });
});

describe('onay kaydı — durum', () => {
  it('İŞ YAPILMADIYSA fikir değiştirilebilir: onay → ret', async () => {
    const j = new InMemoryJournal();
    await resolveApprovals(j, 'r3', { 'call-1': true }, { actor: 'op' });
    // Tur çöktü; tool kaydı hâlâ 'suspended' (terminal değil).
    await j.put(runKeys.tool('r3', 'call-1'), { status: 'suspended' });
    const merged = await resolveApprovals(j, 'r3', { 'call-1': false }, {
      actor: 'op',
      hasRun: async (t) => ((await j.get<{ status?: string }>(runKeys.tool('r3', t)))?.status ?? '') !== 'suspended',
    });
    expect(merged?.['call-1']).toBe(false);
    expect((await j.get<ApprovalRecord>(KEY('r3', 'call-1')))?.decision).toBe(false);
  });

  it('İŞ YAPILDIYSA karar dondu: sonraki cevap yok sayılır', async () => {
    const j = new InMemoryJournal();
    await resolveApprovals(j, 'r4', { 'call-1': true });
    await j.put(runKeys.tool('r4', 'call-1'), { status: 'succeeded' }); // etki gerçekleşti
    const merged = await resolveApprovals(j, 'r4', { 'call-1': false }, {
      hasRun: async () => true,
    });
    // Olmuş bir işi "reddetmek" onu geri almaz; kararı değiştirmek sonucu yeniden yazmak olurdu.
    expect(merged?.['call-1']).toBe(true);
  });

  it('hasRun bilinmiyorsa DEĞİŞTİRME — belirsizlik güvenli yöne yatar', async () => {
    const j = new InMemoryJournal();
    await resolveApprovals(j, 'r5', { 'call-1': true });
    const merged = await resolveApprovals(j, 'r5', { 'call-1': false }); // hasRun verilmedi
    expect(merged?.['call-1']).toBe(true);
  });

  it('aynı cevabın tekrarı bir çatışma değildir (at-least-once istemcinin re-POSTu)', async () => {
    const j = new InMemoryJournal();
    await resolveApprovals(j, 'r6', { 'call-1': true }, { actor: 'ayse' });
    const before = await j.get<ApprovalRecord>(KEY('r6', 'call-1'));
    await resolveApprovals(j, 'r6', { 'call-1': true }, { actor: 'ayse', hasRun: async () => false });
    // Aynı karar yeniden yazılmaz: imza ve zaman damgası İLK cevaba ait kalır.
    expect(await j.get<ApprovalRecord>(KEY('r6', 'call-1'))).toEqual(before);
  });
});

describe('onay kaydı — geriye uyum', () => {
  it('sahadaki ÇIPLAK boolean hâlâ bir karardır', async () => {
    // Migration yok: eski satırlar anlamını korur, yoksa yayınlanmış journalların yarısı
    // "cevap yok" diye okunur ve bekleyen her iş yeniden sorulur.
    const j = new InMemoryJournal();
    await j.put(KEY('r7', 'call-1'), true);
    const merged = await resolveApprovals(j, 'r7', undefined);
    expect(merged?.['call-1']).toBe(true);
    expect(decisionOf(true)).toBe(true);
  });

  it('harcanmış yuva (attempt kapsamı) hâlâ "cevap yok"', async () => {
    const j = new InMemoryJournal();
    await j.put(KEY('r8', 'call-1'), { __gnl_approval_spent: true, at: 1 });
    expect(decisionOf(await j.get(KEY('r8', 'call-1')))).toBeUndefined();
    // Ve insanın TAZE cevabı onu devralır (mevcut davranış korunuyor).
    await resolveApprovals(j, 'r8', { 'call-1': true }, { actor: 'ayse' });
    expect((await j.get<ApprovalRecord>(KEY('r8', 'call-1')))?.decision).toBe(true);
  });

  it('tanınmayan bir satır ONAY olarak okunmaz', async () => {
    // Bozuk/yabancı bir değerin "evet" sayılması, sessizce çalışan bir yan etki demektir.
    expect(decisionOf({ decision: true })).toBeUndefined(); // v yok
    expect(decisionOf('true')).toBeUndefined();
    expect(decisionOf(null)).toBeUndefined();
    expect(decisionOf(undefined)).toBeUndefined();
    // İLERİ SÜRÜM: kaydı daha yeni bir GNL yazmış. Şekli tanımıyoruz; içindeki `true`'yu "evet" diye
    // okumak, anlamını bilmediğimiz bir alana dayanarak yan etki çalıştırmak olurdu.
    expect(decisionOf({ v: 2, decision: true })).toBeUndefined();
    // BOZUK karar: sürüm doğru ama `decision` boolean değil. Truthy bir string'in "evet" sayılması
    // tam da sessizce çalışan yan etki demektir.
    expect(decisionOf({ v: 1, decision: 'yes' })).toBeUndefined();
  });
});
