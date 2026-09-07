// BATCH İŞ-1/İŞ-2 pinleri (hakem: İŞ-1 yayın ön koşulu).
// İŞ-1: modelsiz batch item-run'ının askısı GET /approvals'ta SATIR üretir (sentinel-fallback) —
//        "listRuns suspended der ama tıklanacak satır yok" ihlali kapalı.
// İŞ-2: batch: önekli resume resumeRun'a DÜŞMEZ; karar resolveApprovals'la (spent-slot CAS'lı tek
//        kaynak) journal'a yazılır ve cevap KAYITLI kararı raporlar.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, stampFormat } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;

function seedBatchSuspend(journal: InMemoryJournal) {
  const runId = 'batch:aylik-1:F-1';
  const sentinel = { __gnl_suspend: { toolCallId: 'item:F-1', toolName: 'payInvoice', args: { ref: 'F-1', amount: 100 }, reason: 'Duplicate side effect: approve to repeat' } };
  // Modelsiz item-run: tek tool kaydı, model adımı YOK (mini-runner'ın bıraktığı iz)
  return journal.put(`${runId}:tool:item:F-1`, stampFormat({ status: 'suspended', output: sentinel, toolName: 'payInvoice' })).then(() => runId);
}

describe('İŞ-1 — modelsiz askı inbox\'ta görünür', () => {
  it('batch item askısı GET /approvals satırı üretir (toolName + reason + args ile)', async () => {
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

describe('İŞ-2 — batch resume yalnız karar yazar', () => {
  it('resume opsiyonu YOKKEN bile batch: kararı kaydedilir; spent-slot CAS tek kaynaktan işler; cevap kayıtlı kararı döner', async () => {
    const journal = new InMemoryJournal();
    const runId = await seedBatchSuspend(journal);
    const api = drive(createStudioApi({ reader: journal })); // resume verilmedi — normal run'da 501 olurdu
    const res = await api(new Request(`http://s/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'item:F-1': true } }),
    }));
    expect(res.status).toBe(200);
    const body = await res.json() as { decided: Record<string, boolean> };
    expect(body.decided['item:F-1']).toBe(true);
    expect(await journal.get(`${runId}:approval:item:F-1`)).toBe(true); // resolveApprovals şekli (düz boolean)

    // spent-slot: 'attempt' kapsamının tükettiği karar → taze onay CAS'la üstüne yazılır (kopyada düşen incelik)
    await journal.put(`${runId}:approval:item:F-1`, { __gnl_approval_spent: true });
    const res2 = await api(new Request(`http://s/runs/${encodeURIComponent(runId)}/resume`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ approvals: { 'item:F-1': true } }),
    }));
    expect((await res2.json() as { decided: Record<string, boolean> }).decided['item:F-1']).toBe(true);
    expect(await journal.get(`${runId}:approval:item:F-1`)).toBe(true); // spent sentinel taze kararla değişti
  });

  it('bilinmeyen batch runId → 404 (tool kaydı yok)', async () => {
    const api = drive(createStudioApi({ reader: new InMemoryJournal() }));
    const res = await api(new Request('http://s/runs/batch%3Ayok%3AF-9/resume', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvals: { x: true } }),
    }));
    expect(res.status).toBe(404);
  });
});
