// KÖR NOKTA TESTİ — konformans yürüyüşünün sürmediği kimlik SINIFI.
//
// `client-subject-conformance.test.ts` her rotayı geziyor ve "özne adlandırılmadan hizmet verilmesin"
// kuralını kanıtlıyor. Ama YALNIZ İKİ bearer kimlik sürüyor (`client` ve `admin`), ve roleAuth'un
// bearer kimlik bilgileri bilerek `principal.id` TAŞIMAZ. Yani "kendi adını taşıyan kimlik" sınıfı
// hiç sürülmedi — okuma yolunda özne bağlamasının olmaması (mallory, Ayşe'nin mesajlarını okudu)
// 3645 testin içinden bu yüzden geçebildi.
//
// Kör nokta ROTA TABLOSUNDA değil, ROL MATRİSİNDEYDİ: eksik olan bir satır değil, bir sütundu.
// Bu dosya o sütunu ekliyor. Yeni bir okuma rotası eklenip bağlama unutulursa burada düşer.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';

const model = {
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
};

function makeApi() {
  const threads = new Map<string, string>();
  const memory = {
    loadContext: async (t: string, o?: { resourceId?: string }) => { if (o?.resourceId) threads.set(t, o.resourceId); return { messages: [] as unknown[] }; },
    append: async () => {},
    getMessages: async (t: string) => [{ role: 'user', content: `SECRET-${t}` }],
    getThreadResource: async (t: string) => threads.get(t),
    listThreads: async (o: { resourceId: string }) => [...threads].filter(([, r]) => r === o.resourceId).map(([id, r]) => ({ id, resourceId: r })),
    listAllThreads: async () => [...threads].map(([id, r]) => ({ id, resourceId: r })),
  };
  return createRestApi(
    { storage: new InMemoryStorage(), memoryFactory: () => memory, agents: { a: { model } } } as never,
    {
      subjectBinding: 'strict',
      auth: roleAuth({
        client: { token: 'C', orgId: 'acme' },
        // BU SINIF EKSİKTİ: kendi adını taşıyan kimlik (basic auth → principal.id = 'mallory').
        viewer: { user: 'mallory', pass: 'p', orgId: 'acme' },
      }),
    } as never,
  );
}

/** Ayşe'nin thread'i + koşumu, uygulama kimliğiyle kurulur. */
async function seeded() {
  const api = makeApi();
  const r = await api(new Request('http://x/agents/a/run', {
    method: 'POST',
    headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
    body: JSON.stringify({ runId: 'r-ayse', prompt: 'x', threadId: 't-ayse', resourceId: 'u-ayse' }),
  }));
  expect(r.status).toBe(200);
  return api;
}

/** Başkasının verisini ADRESLEYEN okuma rotaları — burada 200 dönmek bir sızıntıdır. */
const CROSS_SUBJECT_READS = [
  '/runs/r-ayse',
  '/runs/r-ayse?resourceId=u-ayse',
  '/threads/t-ayse/messages',
  '/threads/t-ayse/messages?resourceId=u-ayse',
];

/** Envanter uçları — burada kurbanın satırını GÖRMEK bir sızıntıdır. */
const INVENTORY_READS = ['/threads', '/runs', '/runs?resourceId=u-ayse', '/runs?limit=50'];

describe('bağlı kimlik (principal.id) başkasının verisine ulaşamaz', () => {
  it('adresli okumaların hepsi 403', async () => {
    const api = await seeded();
    const auth = 'Basic ' + Buffer.from('mallory:p').toString('base64');
    const leaked: string[] = [];
    for (const path of CROSS_SUBJECT_READS) {
      const res: Response = await api(new Request(`http://x${path}`, { headers: { authorization: auth } }));
      if (res.status !== 403) leaked.push(`${path} → ${res.status}`);
    }
    expect(leaked, 'bağlı bir kimlik başka bir öznenin verisini okudu').toEqual([]);
  });

  it('liste uçları kendi kapsamına iner — envanter sızmaz', async () => {
    // `/threads` parametresizken `listAllThreads()`e düşüyordu: tek çağrıda TÜM özne envanteri.
    // `/runs` AYNI SINIF ve ilk turda ATLANMIŞTI: /threads'ten silinen envanter oradan aynen
    // okunuyordu — üstelik `threadId` + `resourceId` alanlarıyla, yani kapanan deliğin HEDEF
    // LİSTESİNİ geri veriyordu. Kapıyı üç yere koyup dördüncüsünü atlamak, o kapıdan geçilmesini
    // engellemiyor. Bu yüzden iddia artık tek uç değil, envanter uçlarının TAMAMI.
    //
    // DURUM İDDİASI DA ŞART, ve iki yönlü. İlk hâli yalnız gövde tarıyordu:
    //   - uç 500 dönse ya da boş gövde verse test "sızıntı yok" diye YEŞİL yanıyordu — envanter
    //     kapısını değil, ucun ayakta olup olmadığını ölçmüyordu bile.
    //   - ters yönde, bir hata gövdesi kurbanın adını yankılasa (`resourceId 'u-ayse' forbidden`)
    //     test YANLIŞ kırmızı yanardı: ret cümlesinde geçen isim bir sızıntı değildir.
    // Bu yüzden durum önce doğrulanır, tarama YALNIZ 2xx gövdesinde yapılır. Envanter uçları için
    // uygun küme 200 (kendi kapsamına inmiş liste) veya 403 (kapsam reddi) — 404 yok, rota var.
    const api = await seeded();
    const auth = 'Basic ' + Buffer.from('mallory:p').toString('base64');
    const leaked: string[] = [];
    for (const path of INVENTORY_READS) {
      const res: Response = await api(new Request(`http://x${path}`, { headers: { authorization: auth } }));
      expect([200, 403], `${path} beklenmeyen durum: ${res.status}`).toContain(res.status);
      if (res.status !== 200) continue;
      const body = await res.text();
      if (body.includes('t-ayse') || body.includes('r-ayse') || body.includes('u-ayse')) leaked.push(path);
    }
    expect(leaked, 'envanter ucu başka bir öznenin satırını gösterdi').toEqual([]);
  });

  it('KENDİ verisini okuyabilir — bağlama bir duvar değil, bir sınır', async () => {
    // Bağlama her şeyi kapatsaydı doğru olmazdı: kimliğin kendi verisi kendine açık kalmalı,
    // yoksa "sahibi cevaplasın" tezi uygulanamaz hale gelir.
    const api = makeApi();
    const auth = 'Basic ' + Buffer.from('mallory:p').toString('base64');
    await api(new Request('http://x/agents/a/run', {
      method: 'POST',
      headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
      body: JSON.stringify({ runId: 'r-mal', prompt: 'x', threadId: 't-mal', resourceId: 'mallory' }),
    }));
    const own: Response = await api(new Request('http://x/threads/t-mal/messages', { headers: { authorization: auth } }));
    expect(own.status).toBe(200);
    expect(await own.text()).toContain('SECRET-t-mal');
  });
});
