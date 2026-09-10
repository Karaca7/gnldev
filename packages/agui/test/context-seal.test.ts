// AG-UI ROTASI: bağlam mührü + thread çözücünün koşuma bağlanması.
//
// İKİ AYRI ARIZA, aynı satırların içinde:
//
// 1) `context: body.context` ham geçiyordu. Motor ayrılmış anahtarları "sunucu doğruladı" diye
//    okuyor, dolayısıyla istek kendi öznesini adlandırabiliyordu. Kardeş rotada (chat-adapter,
//    birebir aynı şekil) CANLIDA ölçüldü: `{"context":{"__gnl_resourceId":"KURBAN"}}` taşıyan bir
//    POST koşumu o adla açtırdı. Sahiplik damgası eklendikten sonra sahte ad KİLİDİN de değeri
//    hâline geliyor — yani saldırgan anahtarı kendine veriyor.
//
// 2) `resolveThreadId` hesaplanıyor ama koşuma `body.threadId` geçiyordu: çözücünün sonucu yalnız
//    SSE zarfına gidiyordu. Host'un kimliği auth'tan türetmek için kullanabileceği TEK kanca
//    hafızayı hiç etkilemiyordu — host "düzelttim" sanıyor, koşum yine istemcinin dediği thread'e
//    yazıp okuyordu.
//
// Rotanın auth'u kapsam dışı bırakması DOĞRU ve değişmedi. Yanlış olan, o sınırın ima ettiğiydi.
//
// Ölçüm noktası journal'ın `:input`'u — yani motorun GERÇEKTEN ne kaydettiği. Sahte bir gnl'e
// bakmak, rotanın ne gönderdiğini ölçerdi; kaydedilen şey ise sahipliğin sonradan okunduğu yer.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, GNL_RESOURCE_ID_KEY } from '@gnldev/durable';
import { createAguiRoute } from '../src/route.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

function textMock(): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('no gen'); },
    doStream: async () => ({
      stream: mkStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'ok' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]),
    }),
  };
}

/** Rotayı koştur, sonra motorun DONDURDUĞU girdiyi oku. */
async function drive(body: unknown, opts: Record<string, unknown> = {}) {
  const journal = new InMemoryJournal();
  const app = createAguiRoute({ journal, agents: { a: { model: textMock() } } } as never, opts as never);
  const res = await call(app, '/agents/a/run', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  await res.text(); // akışı tüket → koşum bitsin
  const runId = (body as { runId: string }).runId;
  return await journal.get<{ resourceId?: string; threadId?: string; actor?: string }>(`${runId}:input`);
}

describe('agui: bağlam mührü', () => {
  it('istemcinin yazdığı ayrılmış anahtar özneye DÖNÜŞMEZ', async () => {
    const input = await drive({ runId: 'ag-1', prompt: 'x', context: { [GNL_RESOURCE_ID_KEY]: 'KURBAN' } });
    expect(input?.resourceId).toBeUndefined();
    // Ve sahiplik damgası da sahteye eşitlenmiyor — saldırgan kilidi kendine veremiyor.
    expect(input?.actor).toBeUndefined();
  });

  it('çözücü verilirse SUNUCUNUN öznesi yazılır ve damga ondan basılır', async () => {
    const input = await drive(
      { runId: 'ag-2', prompt: 'x', context: { [GNL_RESOURCE_ID_KEY]: 'KURBAN' } },
      { resolveResourceId: () => 'ayse' },
    );
    expect(input?.resourceId).toBe('ayse');
    expect(input?.actor).toBe('ayse');
  });

  it('resolveThreadId artık KOŞUMA uygulanıyor, yalnız SSE zarfına değil', async () => {
    const input = await drive(
      { runId: 'ag-3', prompt: 'x', threadId: 'istemcinin-threadi' },
      { resolveThreadId: () => 'sunucunun-threadi' },
    );
    expect(input?.threadId).toBe('sunucunun-threadi');
  });

  it('çözücü yoksa davranış değişmez — gövdenin threadId si geçerli', async () => {
    const input = await drive({ runId: 'ag-4', prompt: 'x', threadId: 'gövdeden' });
    expect(input?.threadId).toBe('gövdeden');
  });
});
