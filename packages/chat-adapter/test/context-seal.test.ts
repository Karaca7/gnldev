// SOHBET ROTASI MÜHRÜ — istemci kendi kimliğini uyduramaz.
//
// Bulunuş biçimi: kod okuyarak değil, çalışan bir uygulamaya istek atarak. Düz bir POST'un gövdesine
// `{"context":{"__gnl_resourceId":"KURBAN-KULLANICI"}}` konduğunda koşum o isimle doğdu ve sahiplik
// damgası da onu izledi. Motor ayrılmış anahtarları "sunucu doğruladı" diye okuyor; bu rota ise
// `body.context`'i olduğu gibi iletiyordu, yani kanalın sahibi isteği gönderen kişiydi.
//
// Mühür (registry.ts's sealRequestContext) tam bu saldırı için yazılmış ve @gnldev/server'da
// çağrılıyor. Kimse hata yapmadı: bu rota "auth benim işim değil" diye ilan edilmiş ve kendi
// açısından tutarlı davrandı. İki modülün varsayımı birbiriyle konuşmadı.
import { describe, it, expect } from 'vitest';
import { createChatRoute } from '../src/chat-route.js';
import { GNL_RESOURCE_ID_KEY } from '@gnldev/durable';

/** Koşuma NE ULAŞTIĞINI yakalayan sahte gnl — motora hiç inmeden sözleşmeyi ölçer. */
function spyGnl() {
  const seen: { context?: Record<string, unknown>; resourceId?: string }[] = [];
  return {
    seen,
    gnl: {
      stream: async (_name: string, opts: any) => {
        seen.push({ context: opts.context, resourceId: opts.resourceId });
        return {
          toUIMessageStream: () => new ReadableStream({ start: (c) => c.close() }),
          text: Promise.resolve(''),
        };
      },
    } as any,
  };
}

const post = (app: any, body: unknown) =>
  app.request('/agents/a/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

const MSG = [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'selam' }] }];

describe('chat rotası: bağlam mührü', () => {
  it('istemcinin yazdığı ayrılmış anahtar motora ULAŞMAZ', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl });
    await post(app, { runId: 'r1', messages: MSG, context: { [GNL_RESOURCE_ID_KEY]: 'KURBAN', musteriNo: 42 } });
    expect(seen).toHaveLength(1);
    // Ayrılmış anahtar silindi — "bilmiyorum", "istemcinin dediği"ne tercih edilir.
    expect(GNL_RESOURCE_ID_KEY in (seen[0]!.context ?? {})) .toBe(false);
    // Ayrılmış OLMAYAN alanlar dokunulmadan geçer: mühür bir sansür değil, sahiplik sınırı.
    expect(seen[0]!.context?.musteriNo).toBe(42);
  });

  it('çözücü verilirse SUNUCUNUN değeri yazılır, istemcininki değil', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { resolveResourceId: () => 'ayse' });
    await post(app, { runId: 'r2', messages: MSG, context: { [GNL_RESOURCE_ID_KEY]: 'KURBAN' } });
    expect(seen[0]!.context?.[GNL_RESOURCE_ID_KEY]).toBe('ayse');
    expect(seen[0]!.resourceId).toBe('ayse');
  });

  it('çözücü yoksa özne HİÇ beyan edilmez — sessiz bir varsayılan uydurulmaz', async () => {
    // Kolay ama yanlış olurdu: özneyi body.resourceId'den okumak. O da istemcinin beyanıdır ve
    // kapatılan deliğin ta kendisini başka bir alan adıyla geri açardı.
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl });
    await post(app, { runId: 'r3', messages: MSG, resourceId: 'gövdeden', context: {} });
    expect(seen[0]!.resourceId).toBeUndefined();
    expect(GNL_RESOURCE_ID_KEY in (seen[0]!.context ?? {})).toBe(false);
  });

  it('bağlam hiç gönderilmese de mühür çalışır', async () => {
    const { gnl, seen } = spyGnl();
    const app = createChatRoute({ gnl }, { resolveResourceId: () => 'mehmet' });
    await post(app, { runId: 'r4', messages: MSG });
    expect(seen[0]!.context?.[GNL_RESOURCE_ID_KEY]).toBe('mehmet');
  });
});
