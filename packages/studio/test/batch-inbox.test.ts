// BATCH TASK-1/TASK-2 pins (arbiter: TASK-1 is the release precondition).
// TASK-1: a model-less batch item-run's suspend produces a ROW in GET /approvals (sentinel-fallback) —
//        closes the "listRuns says suspended but there's no row to click" violation.
// TASK-2: a batch:-prefixed resume does NOT fall through to resumeRun; the decision is written to the
//        journal via resolveApprovals (the single spent-slot-CAS source of truth), and the response
//        reports the RECORDED decision.
import { describe, it, expect } from 'vitest';
// Onay kaydı artık imzalı bir nesne; bu testler KARARI sabitliyor, kaydın ŞEKLİNİ değil.
import { InMemoryJournal, stampFormat, decisionOf } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;

function seedBatchSuspend(journal: InMemoryJournal) {
  const runId = 'batch:aylik-1:F-1';
  const sentinel = { __gnl_suspend: { toolCallId: 'item:F-1', toolName: 'payInvoice', args: { ref: 'F-1', amount: 100 }, reason: 'Duplicate side effect: approve to repeat' } };
  // A model-less item-run: a single tool record, NO model step (the trace the mini-runner leaves behind)
  return journal.put(`${runId}:tool:item:F-1`, stampFormat({ status: 'suspended', output: sentinel, toolName: 'payInvoice' })).then(() => runId);
}

describe('TASK-1 — a model-less suspend shows up in the inbox', () => {
  it('a batch item suspend produces a GET /approvals row (with toolName + reason + args)', async () => {
    const journal = new InMemoryJournal();
    await seedBatchSuspend(journal);
    const api = drive(createStudioApi({ reader: journal }));
    const res = await api(new Request('http://s/approvals'));
    const body = await res.json() as { items: Array<{ runId: string; toolCallId: string; toolName: string; reason?: string }> };
    const row = body.items.find((i) => i.runId === 'batch:aylik-1:F-1');
    expect(row).toBeDefined();
    expect(row!.toolCallId).toBe('item:F-1');
    expect(row!.toolName).toBe('payInvoice');
    expect(row!.reason).toContain('Duplicate');
  });
});

describe('TASK-2 — batch resume only writes the decision', () => {
  it('even WITHOUT a resume option, the batch: decision is recorded; spent-slot CAS processes from a single source; the response returns the recorded decision', async () => {
    const journal = new InMemoryJournal();
    const runId = await seedBatchSuspend(journal);
    const api = drive(createStudioApi({ reader: journal })); // no resume given — a normal run would 501 here
    const res = await api(new Request(`http://s/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'item:F-1': true } }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { decided: Record<string, boolean> };
    expect(body.decided['item:F-1']).toBe(true);
    expect(decisionOf(await journal.get(`${runId}:approval:item:F-1`))).toBe(true); // resolveApprovals's shape (a plain boolean)

    // spent-slot: a decision consumed by the 'attempt' scope → a fresh approval overwrites it via CAS (a nuance a copy of this logic would drop)
    await journal.put(`${runId}:approval:item:F-1`, { __gnl_approval_spent: true });
    const res2 = await api(new Request(`http://s/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'item:F-1': true } }),
    }));
    expect((await res2.json() as { decided: Record<string, boolean> }).decided['item:F-1']).toBe(true);
    expect(decisionOf(await journal.get(`${runId}:approval:item:F-1`))).toBe(true); // the spent sentinel was replaced by the fresh decision
  });

  it('yazılan karar KİMİN olduğunu taşır, ve fikir hâlâ değiştirilebilir', async () => {
    // İki eksik, tek çağrıda: bu uç `resolveApprovals`'a hiçbir opsiyon geçmiyordu.
    //   (a) `actor` yok → ApprovalRecord imzasız yazılıyordu. Studio tam da "KİM cevapladı"nın
    //       yüzeyi; imzasız bir karar ne denetlenebilir ne de precision@suspend'de operatör
    //       tıkından ayrılabilir.
    //   (b) `hasRun` yok → fikir-değiştirme kuralı belirsizliği güvenli yöne yatırıp HER değişikliği
    //       yok sayıyordu. Yani gelen kutusu ikinci tıkı davet ediyor, tık hiçbir şey yapmıyordu —
    //       hem de kayıt hâlâ 'suspended' iken, yani iş HENÜZ YAPILMAMIŞKEN.
    const journal = new InMemoryJournal();
    const runId = await seedBatchSuspend(journal);
    const api = drive(createStudioApi({ reader: journal }));
    const post = (decision: boolean) => api(new Request(`http://s/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'item:F-1': decision } }),
    }));

    await post(true);
    const rec = await journal.get<{ actor?: string }>(`${runId}:approval:item:F-1`);
    // Auth kurulmamış konsolda bu 'anon'dur ve öyle olması doğru: Studio'nun KENDİ (bilinmeyen)
    // kimliği, çağıranın beyanı değil (bkz. verifiedActorOf).
    expect(rec?.actor, 'karar imzasız yazıldı').toBe('anon');

    await post(false); // araç kaydı hâlâ 'suspended' — terminal değil, karar açık
    expect(decisionOf(await journal.get(`${runId}:approval:item:F-1`)), 'ret sessizce yutuldu').toBe(false);
  });

  it('an unknown batch runId → 404 (no tool record)', async () => {
    const api = drive(createStudioApi({ reader: new InMemoryJournal() }));
    const res = await api(new Request('http://s/runs/batch%3Ayok%3AF-9/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvals: { x: true } }),
    }));
    expect(res.status).toBe(404);
  });
});
