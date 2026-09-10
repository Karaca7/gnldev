// İŞ AKIŞI ROTALARI KİMLİK KAPILARININ HİÇBİRİNİ ÇAĞIRMIYORDU.
//
// Ajan rotalarında üç kapı var ve üçü de yerli yerinde: `boundSubjectOf` (bağlı kimlik beyanı EZER),
// `ownershipDenied` (bu koşum başkasınınsa 403), `clientSubjectDenied` (uygulama kimliği kimin adına
// çalıştığını söylemeli). `/workflows/*` rotaları bunların hiçbirine uğramıyordu — ve eksiklik fark
// edilmiyordu, çünkü iş akışı koşumları sahipsiz doğuyordu: kapı sorulsa da cevap alamazdı. Sahip
// kaydı bu yama setinde eklendi; bu dosya kapıların ARTIK iş gördüğünü sabitliyor.
//
// ASIL MESELE REPLAY. `POST /workflows/:name/run` kendi belgesinde "iş akışı için TEK resume
// mekanizması" diyor: aynı runId = devam. Yani runId'yi bilen biri kurbanın koşumunu sürdürüp
// dönen `steps[].output` içinde adım çıktılarını okuyabiliyordu. Bir uçta okuma kapısı kurup aynı
// verinin döndüğü yazma ucunu açık bırakmak, kapıyı hiç kurmamakla aynı yere çıkar.
//
// KİMLİK SINIFLARI, bilerek: `client` = uygulama kimliği (principal.id YOK, öznesini beyan eder),
// `superAdmin` bearer = operatör (kimseyi adlandırmaz, org boyunca çalışır), `admin` basic = kendi adını
// TAŞIYAN kimlik (principal.id = 'mallory') — bağlamanın ısırdığı tek sınıf bu sonuncusu. Üçü de
// aynı kurulumda, çünkü kuralın kendisi bir asimetri ve asimetri tek sınıfla gösterilemez.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

/** İlk adım görünür bir sır üretir, ikincisi askıya alır — sızıntı iddiası somut bir metne dayansın. */
const makeWf = () =>
  workflow<string>()
    .then(step('hazirla', async () => 'AYSE-SECRET'))
    .then(waitForResume<{ ok: boolean }>('onay'));

const MALLORY = 'Basic ' + Buffer.from('mallory:p').toString('base64');

function makeApi(binding?: 'declared' | 'strict') {
  const journal = new InMemoryJournal();
  const api = createRestApi(
    { journal, workflows: { w: makeWf() } } as never,
    {
      auth: roleAuth({
        client: { token: 'C' },
        // Operatör ve bağlı kimlik AYRI cred'ler olmak ZORUNDA: roleAuth `id`'yi cred'den okur
        // (`cred.user`), isteğin hangi yolla geldiğinden değil — tek cred'e hem token hem user/pass
        // koymak, bearer'ı da 'mallory' diye bağlar ve operatör muafiyetini test edilemez kılar.
        superAdmin: { token: 'A' },
        admin: { user: 'mallory', pass: 'p' },
      }),
      ...(binding ? { subjectBinding: binding } : {}),
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

const get = (api: never, path: string, authorization: string) =>
  call(api, path, { headers: { authorization } });

/** Ayşe'nin iş akışı koşumu, uygulama kimliğiyle kurulur — sonra yabancılar ona uzanmayı dener. */
async function seeded(binding?: 'declared' | 'strict') {
  const { api, journal } = makeApi(binding);
  const r = await post(api, '/workflows/w/run', 'Bearer C', { runId: 'wf-ayse', resourceId: 'u-ayse', input: 'hi' });
  expect(r.status).toBe(200);
  expect((await r.json() as { suspended?: boolean }).suspended).toBe(true);
  return { api, journal };
}

describe("POST /workflows/:name/run — bağlı özne (subjectBinding: 'strict')", () => {
  it('bağlı kullanıcı BAŞKASININ resourceId siyle koşum başlatamaz — kendi kimliği yazılır', async () => {
    // Ajan /run rotasındaki kuralın aynısı: kimlik beyanı EZER. Ezmeseydi mallory kurbanın adını
    // gövdeye yazar, sahip kaydı kurbanı gösterirdi — ve mallory'nin işi kurbanın silme/listeleme
    // kapsamına girerdi. Sahiplik kaydı o zaman bir korumadan bir kimliğe bürünme aracına dönerdi.
    const { api, journal } = makeApi('strict');
    const res = await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-1', resourceId: 'u-ayse', input: 'hi' });
    expect(res.status).toBe(200);
    expect((await journal.get<{ resourceId?: string }>('wf-1:input'))?.resourceId).toBe('mallory');
  });

  it("YABANCI özne aynı runId'yle geri gelemez — replay 403, adım çıktısı sızmaz", async () => {
    const { api } = await seeded('strict');
    const res = await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-ayse', input: 'hi' });
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('AYSE-SECRET');
  });

  it('kurbanın adını AÇIKÇA yazmak da kurtarmaz', async () => {
    // Bağlamanın çekirdeği: kimlik beyanı ezer. Ezmeseydi saldırgan kurbanın adını yazarak
    // eşleşmeyi kendi sağlardı — kapı var gibi görünüp hiçbir şey yapmazdı.
    const { api } = await seeded('strict');
    const res = await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-ayse', resourceId: 'u-ayse', input: 'hi' });
    expect(res.status).toBe(403);
  });

  it('KENDİ koşumuna geri dönebilir — bağlama bir duvar değil, bir sınır', async () => {
    const { api } = makeApi('strict');
    expect((await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-mal', input: 'hi' })).status).toBe(200);
    const again = await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-mal', resume: { onay: { ok: true } } });
    expect(again.status).toBe(200);
  });

  it('VARSAYILAN davranış değişmedi — bayrak yokken beyan geçerli', async () => {
    // Varsayılanı sessizce çevirmek, org boyunca çalışan her operatörün bugünkü 200'lerini 403
    // yapardı. Değişiklik additive; kapatma kararı kurulumun.
    const { api, journal } = makeApi();
    const res = await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-2', resourceId: 'u-ayse', input: 'hi' });
    expect(res.status).toBe(200);
    expect((await journal.get<{ resourceId?: string }>('wf-2:input'))?.resourceId).toBe('u-ayse');
  });

  it('ÖZNESİZ org işi eskisi gibi — muafiyet duruyor, uydurulmuş sahip yok', async () => {
    const { api, journal } = makeApi('strict');
    const res = await post(api, '/workflows/w/run', 'Bearer A', { runId: 'wf-org', input: 'hi' });
    expect(res.status).toBe(200);
    expect(await journal.get('wf-org:input'), 'öznesiz iş sahip kaydı yaratmamalı').toBeUndefined();
  });
});

describe('GET /workflows/runs — özne süzgeci', () => {
  it('bağlı kullanıcı YALNIZ kendi koşumlarını görür', async () => {
    const { api } = await seeded('strict');
    await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-mal', input: 'hi' });
    const res = await get(api, '/workflows/runs', MALLORY);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body, 'kurbanın koşumu yabancının envanterinde göründü').not.toContain('wf-ayse');
    expect(body).toContain('wf-mal');
  });

  it('özne adlandırmayan uygulama kimliği 400 — envanter kimin adına isteniyor', async () => {
    const { api } = await seeded('strict');
    expect((await get(api, '/workflows/runs', 'Bearer C')).status).toBe(400);
  });

  it('adlandıran uygulama kimliği YALNIZ o kişinin listesini alır', async () => {
    const { api } = await seeded('strict');
    await post(api, '/workflows/w/run', 'Bearer C', { runId: 'wf-mehmet', resourceId: 'u-mehmet', input: 'hi' });
    const body = await (await get(api, '/workflows/runs?resourceId=u-ayse', 'Bearer C')).text();
    expect(body).toContain('wf-ayse');
    expect(body).not.toContain('wf-mehmet');
  });

  it('OPERATÖR tam listeyi görür — asimetri kuralın kendisi', async () => {
    // Operatör org boyunca çalışır ve kimseyi adlandırmaz. Aynı kuralı ona uygulamak, ilk sürümün
    // "yok = kontrolsüz" hatasının ayna görüntüsü olurdu.
    const { api } = await seeded('strict');
    await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-mal', input: 'hi' });
    const body = await (await get(api, '/workflows/runs', 'Bearer A')).text();
    expect(body).toContain('wf-ayse');
    expect(body).toContain('wf-mal');
  });
});

describe('POST /workflows/runs/:id/cancel — kapı ARTIK bir şey buluyor', () => {
  it('başka bir bağlı özne kurbanın koşumunu iptal EDEMEZ', async () => {
    // Bu kapı kodda hep vardı ama sahibi hiç bulamıyordu (`:input` yazılmıyordu), yani her çağrıda
    // sessizce geçiyordu. Sahip kaydı geldi; test artık kapının gerçekten kapandığını sabitliyor.
    const { api } = await seeded('strict');
    const res = await call(api, '/workflows/runs/wf-ayse/cancel', { method: 'POST', headers: { authorization: MALLORY } });
    expect(res.status).toBe(403);
  });

  it('sahibi iptal EDEBİLİR', async () => {
    const { api } = makeApi('strict');
    await post(api, '/workflows/w/run', MALLORY, { runId: 'wf-mal', input: 'hi' });
    const res = await call(api, '/workflows/runs/wf-mal/cancel', { method: 'POST', headers: { authorization: MALLORY } });
    expect(res.status).toBe(200);
    expect((await res.json() as { cancelled?: boolean }).cancelled).toBe(true);
  });

  it('OPERATÖR iptal edebilir — kimseyi adlandırmıyor', async () => {
    const { api } = await seeded('strict');
    const res = await call(api, '/workflows/runs/wf-ayse/cancel', { method: 'POST', headers: { authorization: 'Bearer A' } });
    expect(res.status).toBe(200);
  });
});
