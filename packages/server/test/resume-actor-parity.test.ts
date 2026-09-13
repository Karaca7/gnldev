// AYNI ÇAĞIRAN, AYNI runId: `/run` REDDEDİYOR, `/resume` SERVİS EDİYORDU.
//
// Ölçüm (bu dosya yazılmadan önce, canlı kurulumla): 'u-ayse' adına açılmış HAM bir runId'ye
// mallory (kendi adını taşıyan bir kimlik: basic auth, `principal.id = 'mallory'`) uzanıyor.
//
//   POST /agents/a/run     beyan yok → 409 run_actor_mismatch   (motorun actor kilidi ateşliyor)
//   POST /agents/a/run     resourceId=u-ayse (kurbanın adı) → 409 (kenar tatmin oldu, MOTOR yakaladı)
//   POST /agents/a/resume  beyan yok → 200 + "AYSE-SECRET"      ← iki kapıdan da kaçtı
//
// NEDEN KAÇIYOR, ikisi ayrı sebep:
//   • Kenar (`ownershipDenied`) yalnız BEYAN EDİLENİ sorar. Hiçbir şey beyan etmeyen istek sessizce
//     geçer — bu rotanın kendi yorumunun yazdığı gibi, "Unstated stays permitted".
//   • Motorun actor kilidi (`RunActorMismatchError`) burada YAPISAL OLARAK ateşleyemez: resume
//     kendi kendine yeten bir çağrı olduğu için özneyi DONMUŞ `:input`'tan okuyup mühürlüyor
//     (`resourceId: input.resourceId`), damga da o mühürden basılıyor. Yani motor her seferinde
//     ayse'yi ayse ile karşılaştırıyor. Kilit orada, ama karşılaştırdığı iki değer aynı kaynaktan
//     geliyor.
//
// Rotanın kendi yorumu bu senaryoyu zaten yasaklamış: "the body carries `approvals`, so a caller who
// is denied /run could otherwise resume a run someone else started and approve the exact tool call
// the human gate had stopped". Ölçüm o cümlenin harfiyen gerçekleştiğini gösteriyor — mallory /run'da
// reddediliyor, /resume'da hem ayse'nin metnini okuyor hem `approvals` gönderebiliyor.
//
// DÜZELTMENİN SINIRI, bilerek dar: bu kapı yalnız /resume'da ve yalnız MOTORUN SORACAĞI soruyu sorar
// — "adını taşıyan çağıranın kimliği, koşumun doğuşta basılan damgasıyla aynı mı". Adı olmayan
// kimlikler (operatör bearer'ı, `client` uygulama kimliği) motorda olduğu gibi burada da muaf, ve
// damgasız eski koşumlar da öyle: /run'ın bugün reddetmediğini /resume da reddetmez.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(text: string): any {
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({
      content: [{ type: 'text', text }],
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      warnings: [],
    }),
    doStream: async () => { throw new Error('no stream'); },
  };
}

/** Kendi adını TAŞIYAN kimlik — bağlamanın (ve motordaki damganın) ısırdığı tek sınıf. */
const MALLORY = 'Basic ' + Buffer.from('mallory:p').toString('base64');
const SECRET = 'AYSE-SECRET';

function makeApi() {
  const journal = new InMemoryJournal();
  const api = createRestApi(
    { journal, agents: { a: { model: mkModel(SECRET) } } } as never,
    {
      auth: roleAuth({
        client: { token: 'C' },
        superAdmin: { token: 'A' }, // operatör: cred'de `user` yok → principal.id YOK → muaf
        admin: { user: 'mallory', pass: 'p' },
      }),
    } as never,
  );
  return { api: api as never, journal };
}

const post = (api: never, path: string, authorization: string, body: unknown) =>
  call(api, path, {
    method: 'POST',
    headers: { authorization, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** Ayşe'nin koşumu, uygulama kimliğiyle onun adına açılır — damga (`actor`) doğuşta basılır. */
async function seeded() {
  const { api, journal } = makeApi();
  const r = await post(api, '/agents/a/run', 'Bearer C', { runId: 'raw-ayse', prompt: 'hi', resourceId: 'u-ayse' });
  expect(r.status).toBe(200);
  expect(await journal.get<{ actor?: string }>('raw-ayse:input')).toMatchObject({ actor: 'u-ayse', resourceId: 'u-ayse' });
  return { api, journal };
}

describe('POST /agents/:name/resume — damga eşitliği (/run neyi reddediyorsa o da reddeder)', () => {
  it('ÖLÇÜM ÇAPASI: aynı çağıran /run üzerinde motorun actor kilidine takılıyor (409)', async () => {
    const { api } = await seeded();
    const res = await post(api, '/agents/a/run', MALLORY, { runId: 'raw-ayse', prompt: 'zzz' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'run_actor_mismatch', detail: { ownerActor: 'u-ayse', requestedActor: 'mallory' } });
  });

  it('KIRMIZI: beyan etmeyen yabancı kimlik, başkasının koşumunu resume edemez', async () => {
    const { api } = await seeded();
    const res = await post(api, '/agents/a/resume', MALLORY, { runId: 'raw-ayse' });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('KIRMIZI: kurbanın adını beyan etmek kapıyı GÖLGELEYEMEZ (kenar tatmin olsa da)', async () => {
    // `ownershipDenied`'ın beklentisi query > gövde sırasıyla kuruluyor, yani saldırgan kurbanın
    // adını yazarak o kapıyı memnun edebilir — /run'da bunu motor yakalıyor (409). Burada motor
    // ateşleyemediği için kapının çağıranın KENDİ kimliğine bakması, beyanına değil, şart.
    const { api } = await seeded();
    for (const claim of ['?resourceId=u-ayse', '']) {
      const res = await call(api, `/agents/a/resume${claim}`, {
        method: 'POST',
        headers: { authorization: MALLORY, 'content-type': 'application/json' },
        body: JSON.stringify({ runId: 'raw-ayse', resourceId: 'u-ayse', approvals: { charge: true } }),
      });
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain(SECRET);
    }
  });

  it('koşum mallory’nin kendisininse resume çalışır — kapı sahibi durdurmaz', async () => {
    const { api } = makeApi();
    const start = await post(api, '/agents/a/run', MALLORY, { runId: 'raw-mallory', prompt: 'hi' });
    expect(start.status).toBe(200);
    const res = await post(api, '/agents/a/resume', MALLORY, { runId: 'raw-mallory' });
    expect(res.status).toBe(200);
  });

  it('operatör (adı olmayan bearer) ve uygulama kimliği muaf kalır — motordaki muafiyetin aynısı', async () => {
    const { api } = await seeded();
    // Operatör: cred'de `user` yok → principal.id yok → motorda da damga basılmaz, kapı da susar.
    expect((await post(api, '/agents/a/resume', 'Bearer A', { runId: 'raw-ayse' })).status).toBe(200);
    // Uygulama kimliği, kendi kullanıcısı adına: `client`ın işi zaten öznesini beyan etmek.
    expect((await post(api, '/agents/a/resume', 'Bearer C', { runId: 'raw-ayse', resourceId: 'u-ayse' })).status).toBe(200);
  });

  it('damgasız (eski) koşum: /run reddetmiyorsa /resume de reddetmez', async () => {
    const { api, journal } = await seeded();
    // 71ae8269 öncesi doğmuş bir kayıt: sahip var, damga yok.
    const input = await journal.get<Record<string, unknown>>('raw-ayse:input');
    const { actor: _drop, ...withoutActor } = input as { actor?: string };
    await journal.put('raw-ayse:input', withoutActor);
    // /run: motor sessiz (damga yok) — kenar da beyan olmadığı için sessiz.
    expect((await post(api, '/agents/a/run', MALLORY, { runId: 'raw-ayse', prompt: 'hi' })).status).toBe(200);
    // /resume aynı yerde durur: bu yama parite kuruyor, yeni bir yasak koymuyor.
    expect((await post(api, '/agents/a/resume', MALLORY, { runId: 'raw-ayse' })).status).toBe(200);
  });
});
