// MOTORDAKİ İKİ KAPI HTTP'YE İSTEMCİ HATASI OLARAK ÇIKMALI, 500 OLARAK DEĞİL.
//
// `POST /workflows/:name/run` gövdeden `runId`, `resourceId` ve `threadId` alıyor — yani K1
// (rezerve anahtar ailesini ele geçiren runId) ve K2 (başkasının thread'ini beyan etme) saldırılarının
// İKİSİ de bu rotadan geçiyor. Motor artık ikisini de girişte reddediyor; burada sabitlenen şey
// reddin İSTEMCİYE nasıl göründüğü: 500 dönseydi bunlar "sunucu arızası" gibi okunur, hem istemci
// yeniden dener hem de operatör olmayan bir hatayı kovalardı.
//
// Yeni bir eşleme mekanizması yok, olan izleniyor: ThreadOwnerMismatchError zaten
// CALLER_CONFLICT_CODES ailesinde (409 + `thread_owner_mismatch`, `resumable` YOK — retry temizlemez),
// runId süzgeci ise sade bir Error, rotanın son çaresi olan 400'e düşüyor. İkisi de 4xx.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

const wf = { build: () => [{ id: 's1' }], run: async () => ({ ok: true }) };

const post = (api: any, body: unknown) =>
  call(api, '/workflows/w/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('/workflows/:name/run — kimlik kapıları HTTP tarafında', () => {
  it("rezerve runId 4xx döner ve `mem:input` journal'a yazılmaz", async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, workflows: { w: wf } } as never);
    const res = await post(api, { runId: 'mem', resourceId: 'mallory', input: {} });
    expect(res.status).toBe(400);
    expect((await res.json() as any).error).toMatch(/reserved key family/);
    expect(await journal.get('mem:input')).toBeUndefined();
  });

  it("başkasının thread'i 409 + thread_owner_mismatch döner", async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({
      journal,
      memory: { getMessages: async () => [], append: async () => {}, getThreadResource: async () => 'u-ayse' },
      workflows: { w: wf },
    } as never);
    const res = await post(api, { runId: 'hj-1', resourceId: 'mallory', threadId: 't-ayse', input: {} });
    expect(res.status).toBe(409);
    const body = await res.json() as any;
    expect(body.code).toBe('thread_owner_mismatch');
    expect(body.resumable).toBeUndefined(); // yeniden deneme bunu temizlemez
    expect(await journal.get('hj-1:input')).toBeUndefined();
  });

  it('sıradan koşum eskisi gibi 200', async () => {
    const journal = new InMemoryJournal();
    const api = createRestApi({ journal, workflows: { w: wf } } as never);
    const res = await post(api, { runId: 'ok-1', resourceId: 'u-ayse', input: {} });
    expect(res.status).toBe(200);
    expect((await res.json() as any).ok).toBe(true);
  });
});
