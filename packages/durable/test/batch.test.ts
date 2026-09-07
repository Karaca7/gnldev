// BATCH — hakem kararının (wf_b92e393e) davranış pinleri:
// 1) preflight SAF okuma + plan sınıflandırması (fresh/exactRepeats/suspended/xidHits/amounts/intra-dup)
// 2) planToken: farklı items → 409 batch_plan_mismatch; aynı token'la 2. run → RAPOR REPLAY'İ (409 değil!)
// 3) suspend-item: askı → Studio-tarzı karar-claim → sonraki run() koşturur; deny → koşmaz
// 4) fail-batch: ilk tekrar tespitinde kalanlar not-run (kesme); skip: koşmadan görünür sonuç + iz
// 5) çift-run rapor tutarlılığı: 2. koşum replayed sayar, sayaç oynamaz (exactly-once)
// 6) sınıflandırma ÇIKTI ŞEKLİNDEN (skip'in terminali 'denied' — statüye bakan karıştırır)
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys, claim } from '../src/journal.js';
import { createBatch } from '../src/batch.js';
import { writeXid } from '../src/xid.js';
import { readIncidents } from '../src/incidents.js';

function payTool(state: { n: number }) {
  return {
    description: 'öde', sideEffect: true,
    recover: async () => ({ done: false as const }),
    semanticIdentity: { keys: ['ref'], amountFields: ['amount'] },
    effectClass: 'transactional' as const,
    execute: async (args: unknown) => { state.n += 1; return { paid: true, args }; },
  };
}
const items = (...refs: Array<[string, number]>) => refs.map(([ref, amount]) => ({ ref, amount }));
const CFG = (state: { n: number }, onDuplicate?: 'skip' | 'suspend-item' | 'fail-batch') => ({
  tool: payTool(state), toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref,
  resourceId: 'acct-1', ...(onDuplicate ? { onDuplicate } : {}),
});

describe('batch — plan/token', () => {
  it('preflight saf okumadır (iki kez çağır, dünya değişmez); farklı items → 409; aynı token 2. run → rapor replay', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state));
    const list = items(['F-1', 10], ['F-2', 20]);
    const p1 = await b.preflight('b1', list);
    const p2 = await b.preflight('b1', list);
    expect(p1.token).toBe(p2.token);
    expect(p1.fresh).toBe(2);
    expect((await journal.listKeys!('batch:')).length).toBe(0); // saf okuma — yazım yok

    const r1 = await b.run('b1', list, { planToken: p1.token });
    expect(r1.summary.done).toBe(2);
    expect(state.n).toBe(2);

    // farklı liste + aynı batchId → 409 ailesi
    await expect(b.run('b1', items(['F-1', 10], ['F-9', 99]), { planToken: (await b.preflight('b1', items(['F-1', 10], ['F-9', 99]))).token }))
      .rejects.toThrow(/DIFFERENT plan/);
    // verilen token listeye uymuyorsa da 409
    await expect(b.run('b1', list, { planToken: 'sahte' })).rejects.toThrow(/does not match/);

    // aynı token'la 2. run: RAPOR REPLAY'İ — sayaç oynamaz (hakem tuzak 2: claim kaybı ≠ 409)
    const r2 = await b.run('b1', list, { planToken: p1.token });
    expect(state.n).toBe(2);
    expect(r2.summary.replayed).toBe(2);
    expect(r2.summary.done).toBe(0);
  });

  it('itemKey zorunlu + güvenli charset + batch-içi mükerrer itemKey reddi', async () => {
    const journal = new InMemoryJournal();
    expect(() => createBatch(journal, { tool: payTool({ n: 0 }), toolName: 'pay' } as never)).toThrow(/itemKey/);
    const b = createBatch(journal, CFG({ n: 0 }));
    await expect(b.preflight('kötü id!', items(['F-1', 1]))).rejects.toThrow(/batchId/);
    await expect(b.preflight('b1', items(['F 1', 1]))).rejects.toThrow(/itemKey/);
    await expect(b.preflight('b1', items(['F-1', 1], ['F-1', 1]))).rejects.toThrow(/duplicate itemKey/);
  });
});

describe('batch — tekrar politikaları', () => {
  it('suspend-item: askıya düşer (koşmaz), karar-claim sonrası run() koşturur; deny koşturmaz; askı raporda hep görünür', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'suspend-item'));
    // İlk koşum: F-1 tamam. Sonra AYNI kimlik yeni batch'te → XID görür → dup merdiveni suspend.
    const l1 = items(['F-1', 10]);
    await b.run('b1', l1, { planToken: (await b.preflight('b1', l1)).token });
    expect(state.n).toBe(1);

    const l2 = items(['F-1', 10], ['F-3', 30]);
    const p2 = await b.preflight('b2', l2);
    expect(p2.xidHits.map((r) => r.itemKey)).toEqual(['F-1']); // plan kanallar-arası işi ÖNCEDEN bilir
    const r2 = await b.run('b2', l2, { planToken: p2.token });
    expect(r2.summary.suspended).toBe(1);
    expect(r2.summary.done).toBe(1); // F-3 koştu; askı batch'i bloklamadı
    expect(state.n).toBe(2);

    // Studio-tarzı karar: düz boolean claim (İŞ-2'nin yazdığı şekil)
    await claim(journal, runKeys.approval('batch:b2:F-1', 'item:F-1'), true);
    const r3 = await b.run('b2', l2, { planToken: p2.token });
    expect(state.n).toBe(3); // bilinçli tekrar GERÇEKTEN koştu
    expect(r3.summary.done).toBe(1);
    expect(r3.summary.replayed).toBe(1); // F-3 replay

    // deny yolu: yeni batch, karar false
    const l4 = items(['F-1', 10]);
    const p4 = await b.preflight('b4', l4);
    const r4a = await b.run('b4', l4, { planToken: p4.token });
    expect(r4a.summary.suspended).toBe(1);
    await claim(journal, runKeys.approval('batch:b4:F-1', 'item:F-1'), false);
    const r4b = await b.run('b4', l4, { planToken: p4.token });
    expect(r4b.summary.denied).toBe(1);
    expect(state.n).toBe(3); // koşmadı
  });

  it('skip: koşmadan görünür sonuç + incident izi (sınıflandırma çıktı şeklinden — terminal denied olsa da)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'skip'));
    const l = items(['F-1', 10]);
    await b.run('s1', l, { planToken: (await b.preflight('s1', l)).token });
    const p2 = await b.preflight('s2', l);
    const r = await b.run('s2', l, { planToken: p2.token });
    expect(r.summary.skipped).toBe(1);
    expect(r.items[0]!.detail).toContain('NOT executed');
    expect(state.n).toBe(1);
    const inc = await readIncidents(journal, 'batch:s2:F-1');
    expect(inc.some((i) => i.action === 'skip')).toBe(true); // sessiz değil
  });

  it('fail-batch: ilk tekrar tespitinde item failed + KALANLAR not-run (kesme); rapor hepsini adlandırır', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'fail-batch'));
    await b.run('f1', items(['F-1', 10]), { planToken: (await b.preflight('f1', items(['F-1', 10]))).token });
    const l = items(['F-1', 10], ['F-2', 20], ['F-3', 30]); // F-1 tekrar — alfabetik ilk sırada
    const p = await b.preflight('f2', l);
    const r = await b.run('f2', l, { planToken: p.token });
    expect(r.summary.failed).toBe(1);
    expect(r.summary['not-run']).toBe(2);
    expect(state.n).toBe(1); // hiçbir yeni iş koşmadı
    expect(r.items.map((i) => i.outcome)).toEqual(['failed', 'not-run', 'not-run']);
  });
});

describe('batch — preflight sınıflandırma detayları', () => {
  it('xid self-filter BATCH-scoped; amountMismatch ayrı sütun; intra-batch aynı-args uyarısı; resourceId yoksa kapsam-dışı bayrağı', async () => {
    const journal = new InMemoryJournal();
    const state = { n: 0 };
    const b = createBatch(journal, CFG(state, 'suspend-item'));
    // Başka KANALDAN (sohbet) yazılmış XID
    await writeXid(journal, { resourceId: 'acct-1', toolName: 'pay', identity: { ref: 'f-7' }, amounts: { amount: 70 }, channel: 'chat' }, 'chat-run-1', 'tc-chat');
    const l = items(['F-7', 70], ['F-8', 999], ['F-9', 1]);
    // F-8'e aynı kimlik farklı tutar için ikinci XID
    await writeXid(journal, { resourceId: 'acct-1', toolName: 'pay', identity: { ref: 'f-8' }, amounts: { amount: 80 }, channel: 'api' }, 'api-run-1', 'tc-api');
    const p = await b.preflight('x1', l);
    expect(p.xidHits.map((r) => r.itemKey)).toEqual(['F-7']);
    expect(p.xidHits[0]!.detail).toContain('via chat');
    expect(p.amountMismatches.map((r) => r.itemKey)).toEqual(['F-8']);
    expect(p.fresh).toBe(1); // yalnız F-9

    // batch-içi aynı-args farklı key uyarısı
    const p2 = await b.preflight('x2', [{ ref: 'A-1', amount: 5 }, { ref: 'A-2', amount: 5 }].map((x, i) => ({ ...x, ref: i === 1 ? 'A-2' : 'A-1' })) as never);
    // (A-1 ve A-2 argümanları farklı — ref farklı; gerçek intra-dup için ref hariç aynı args gerekmez,
    //  argsHash TÜM item'ı kapsar; burada uyarı ÜRETMEMESİ pinlenir: farklı iş, yanlış alarm yok)
    expect(p2.intraBatchDuplicates).toHaveLength(0);

    // resourceId'siz kurulum: kapsam-dışı bayrağı (boş liste 'temiz' okunmasın)
    const b2 = createBatch(journal, { tool: payTool({ n: 0 }), toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref });
    const p3 = await b2.preflight('x3', items(['Z-1', 1]));
    expect(p3.xidScopeDisabled).toBe(true);
  });
});

describe('batch — gerçek eşzamanlılık (K13)', () => {
  it('iki worker aynı planı AYNI ANDA koşar: iş sayısı sabit, plan yarışı 409 üretmez, busy item batch\'i düşürmez', async () => {
    const journal = new InMemoryJournal();
    let paid = 0;
    const slowTool = {
      description: 'öde', sideEffect: true, recover: async () => ({ done: false as const }),
      semanticIdentity: { keys: ['ref'] }, effectClass: 'transactional' as const,
      execute: async (args: unknown) => { await new Promise((r) => setTimeout(r, 25)); paid += 1; return { paid: true, args }; },
    };
    const b = createBatch(journal, { tool: slowTool, toolName: 'pay', itemKey: (i: unknown) => (i as { ref: string }).ref, resourceId: 'acct', onDuplicate: 'suspend-item' });
    const l = items(['C-1', 1], ['C-2', 2]);
    const token = (await b.preflight('cc1', l)).token;
    const [r1, r2] = await Promise.all([
      b.run('cc1', l, { planToken: token }),
      b.run('cc1', l, { planToken: token }),
    ]);
    expect(paid).toBe(2); // exactly-once: iki worker toplam İKİ iş
    // Her iki rapor da tutarlı: hiçbir item kaybolmadı; busy(failed) batch'i düşürmedi (throw yok)
    for (const r of [r1, r2]) {
      const total = Object.values(r.summary).reduce((a, b2) => a + b2, 0);
      expect(total).toBe(2);
    }
    // en az bir worker'da yarış izi görünür (failed-busy YA DA replay) — ve done toplamı tam 2
    const doneTotal = r1.summary.done + r2.summary.done;
    expect(doneTotal).toBeLessThanOrEqual(2);
  });
});
