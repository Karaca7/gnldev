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
import { asEndUsers } from './end-users.js';
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
      auth: asEndUsers(roleAuth({
        client: { token: 'C' },
        superAdmin: { token: 'A' }, // staff: names nobody, exempt
        admin: { user: 'mallory', pass: 'p' }, // an END USER, see asEndUsers
      }), ['mallory']),
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
  it('ANCHOR: the same caller on /run is refused at the edge (403) and learns no owner', async () => {
    const { api } = await seeded();
    const res = await post(api, '/agents/a/run', MALLORY, { runId: 'raw-ayse', prompt: 'zzz' });
    // An end user is bound to itself by default now, so `ownershipDenied` answers before the engine's
    // actor lock can. That lock's 409 said "run 'raw-ayse' belongs to actor 'u-ayse'" — the sentence
    // `FOREIGN_PARTY_DETAIL_FIELDS` could not redact. An end user no longer reaches it on this path.
    expect(res.status).toBe(403);
    expect(await res.text(), 'the refusal named the owner').not.toContain('u-ayse');
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

  it('a run stamped with an actor but no recorded subject: only the actor says whose it is', async () => {
    // A host that writes its own route passes `actor` without sealing a subject, so the record carries
    // an actor and no `resourceId`. The subject gate has nothing to compare; the actor is the only
    // owner on file, and an end user is still held to it.
    const { api, journal } = await seeded();
    const input = await journal.get<Record<string, unknown>>('raw-ayse:input');
    const { resourceId: _drop, ...actorOnly } = input as { resourceId?: string };
    await journal.put('raw-ayse:input', actorOnly);
    const res = await post(api, '/agents/a/resume', MALLORY, { runId: 'raw-ayse' });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain(SECRET);
  });

  it('an unstamped (older) run: /run and /resume still answer the same — both refuse', async () => {
    const { api, journal } = await seeded();
    // A record born before 71ae8269: an owner, no actor stamp. The engine's lock is silent on it, but
    // the owner is recorded, and an end user is held to its own.
    const input = await journal.get<Record<string, unknown>>('raw-ayse:input');
    const { actor: _drop, ...withoutActor } = input as { actor?: string };
    await journal.put('raw-ayse:input', withoutActor);
    expect((await post(api, '/agents/a/run', MALLORY, { runId: 'raw-ayse', prompt: 'hi' })).status).toBe(403);
    expect((await post(api, '/agents/a/resume', MALLORY, { runId: 'raw-ayse' })).status).toBe(403);
  });
});
