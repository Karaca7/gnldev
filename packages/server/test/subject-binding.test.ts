// OKUMA YOLUNDA ÖZNE BAĞLAMA — `subjectBinding: 'strict'`.
//
// Kapatılan arıza (ölçüldü): son kullanıcılara kullanıcı-deposu token'ı veren bir kurulumda,
// `mallory` başka bir son kullanıcının verisini okuyabiliyordu — `/threads` tüm özne envanterini,
// `/threads/t-ayse/messages` gizli mesajı, `/runs/r-ayse` tam journal'ı, hepsi 200. Kurbanın adını
// AÇIKÇA yazmak da 200 dönüyordu, çünkü beklenti çağıranın kendi beyanından geliyordu: kapı
// kendi anahtarını dağıtıyordu.
//
// Kök neden, kapının yokluğu değil: aynı kimlik YAZARKEN özne (`resolveResourceId` bir ad ister),
// OKURKEN operatör sayılıyordu. Asimetri buradaydı.
//
// Bayrak arkasında olmasının sebebi: varsayılanı çevirmek, organizasyonu boyunca okuyan her
// operatörün bugünkü 200'lerini 403 yapar — ki o kullanım belgeli ve amaçlanan. Bayrak, son
// kullanıcılara token veren kurulumun deliği ŞİMDİ kapatmasını sağlıyor.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const mkModel = () => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
});

function memoryStore() {
  const owners = new Map<string, string>();
  const store = {
    loadContext: async (threadId: string, o?: { resourceId?: string }) => {
      if (o?.resourceId) owners.set(threadId, o.resourceId);
      return { messages: [] as unknown[] };
    },
    append: async () => {},
    getMessages: async (threadId: string) => [{ role: 'user', content: `AYSE-SECRET in ${threadId}` }],
    getThreadResource: async (threadId: string) => owners.get(threadId),
    listThreads: async (o: { resourceId: string }) => [...owners].filter(([, r]) => r === o.resourceId).map(([id, r]) => ({ id, resourceId: r })),
    listAllThreads: async () => [...owners].map(([id, r]) => ({ id, resourceId: r })),
  };
  return () => store;
}

/** Ayşe'nin thread'i + koşumu uygulama kimliğiyle kurulur; sonra `mallory` kendi kimliğiyle okur. */
async function setup(binding?: 'declared' | 'strict') {
  const app = createRestApi(
    { storage: new InMemoryStorage(), memoryFactory: memoryStore() as never, agents: { a: { model: mkModel() as never } } } as never,
    {
      auth: roleAuth({ client: { token: 'C', orgId: 'acme' }, viewer: { user: 'mallory', pass: 'p', orgId: 'acme' } }),
      ...(binding ? { subjectBinding: binding } : {}),
    } as never,
  );
  const seed = await app(new Request('http://x/agents/a/run', {
    method: 'POST',
    headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'r-ayse', prompt: 'gizli', threadId: 't-ayse', resourceId: 'u-ayse' }),
  }));
  expect(seed.status).toBe(200);
  const auth = 'Basic ' + Buffer.from('mallory:p').toString('base64');
  return async (path: string) => {
    const r = await app(new Request(`http://x${path}`, { headers: { authorization: auth } }));
    return { status: r.status, body: await r.text() };
  };
}

describe("subjectBinding: 'strict'", () => {
  it('başkasının mesajı 403 — beyan yerine KİMLİK esas alınır', async () => {
    const get = await setup('strict');
    const msgs = await get('/threads/t-ayse/messages');
    expect(msgs.status).toBe(403);
    expect(msgs.body).not.toContain('AYSE-SECRET');
  });

  it('kurbanın adını AÇIKÇA yazmak da kurtarmaz', async () => {
    // Bağlamanın çekirdeği: kimlik, çağıranın beyanını EZER. Ezmeseydi saldırgan kurbanın adını
    // yazarak eşleşmeyi kendisi sağlardı — kontrol var gibi görünüp hiçbir şey yapmazdı.
    const get = await setup('strict');
    expect((await get('/threads/t-ayse/messages?resourceId=u-ayse')).status).toBe(403);
  });

  it('thread envanteri kendi listesine iner — listAllThreads a düşmez', async () => {
    const get = await setup('strict');
    const threads = await get('/threads');
    expect(threads.status).toBe(200);
    expect(threads.body).not.toContain('t-ayse'); // mallory'nin hiç thread'i yok
  });

  it('başkasının koşumu 403', async () => {
    const get = await setup('strict');
    expect((await get('/runs/r-ayse')).status).toBe(403);
  });

  it('VARSAYILAN davranış değişmedi — bayrak yokken bugünkü gibi', async () => {
    // Bu test bilerek "açığı" doğruluyor: varsayılanı sessizce çevirmek, organizasyonu boyunca
    // okuyan operatörlerin işini kırardı. Değişiklik additive; kapatma kararı kurulumun.
    const get = await setup();
    expect((await get('/threads/t-ayse/messages')).status).toBe(200);
    expect((await get('/runs/r-ayse')).status).toBe(200);
  });

  it("'declared' açıkça verildiğinde de varsayılanla aynı", async () => {
    const get = await setup('declared');
    expect((await get('/threads/t-ayse/messages')).status).toBe(200);
  });
});
