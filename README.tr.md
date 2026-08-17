# GNL — Correct Durable Agents

[English](./README.md) · **Türkçe**

**Vercel AI SDK üstüne ince bir "correctness katmanı" — server kurmadan durable execution.** AI SDK'nın
agentic loop'unu (`generateText`/`streamText` + `tools`) değiştirmeden, iki sarmalayıcı + bir journal ile
ekler: **yan etkili bir tool çağrısı ASLA sessizce iki kere olmaz.** Bunun kesin anlamı **"exactly-once
effect"**tir — çağrı-bazlı dedup + güvenli-varsayılan: `recover()`/`idempotencyKey` ile garanti sağlayıcının
kendisine kadar uzanır, belirsizlikte (crash sonrası sonuç bilinmiyorsa) sessiz tekrar yerine **blok + onay**.
AI SDK biliyorsan bunu da biliyorsun.

```ts
import { runDurable } from '@gnldev/durable';
import { SqliteStorage } from '@gnldev/durable/sqlite';

const res = await runDurable({
  runId: 'order-123',                       // idempotency anahtarı (genelde orderId/sessionId)
  journal: new SqliteStorage('runs.db').runs,
  model, tools: { chargeCard }, prompt: 'Siparişi iptal et, benzer ürün öner',
});
// Çökme sonrası: AYNI runId ile tekrar çağır → kart 2. kez çekilmez, loop kaldığı yerden biter.
```

## Neden? (koz — code-verified)
Agent framework'lerinde durability ya yok ya da **opak snapshot** düzeyinde (ör. policy'ye tabi bir durable agent'ın
step-snapshot'ı — eşzamanlı resume'da çift çalıştırmayı engelleyen atomik claim yok, bir adımdan replay/fork yok; retry'da
idempotency kullanıcıya bırakılır → çift-tahsilat riski). GNL'in tek ama keskin farkı: **çağrı-bazında CAS-garantili
exactly-once effect** — aynı tool çağrısı (`toolCallId`) ASLA iki kez çalışmaz; opt-in `idempotency: 'args'` ile aynı
**argümanlar** da iki kez çalışmaz — model aynı işi yepyeni bir `toolCallId` ile yeniden planlasa bile (sahadaki baskın
duplicate vakası, aşağıya bak); sonucu belirsiz kalan bir çağrı önce
`recover()` ile sağlayıcıya sorulur, hâlâ belirsizse sessizce tekrar etmek yerine **bloklanıp insan onayı istenir**
— **+ deterministic replay + time-travel.** Her özellik tek bir `Journal` arayüzü üstüne kurulur → bu garantileri
**miras alır.**

### LLM-aware idempotency (`idempotency: 'args'`)
Sahada belgelenmiş çift-yan-etki vakalarının çoğu crash-replay'den değil, LLM'in aynı işi **yeni** bir
`toolCallId` ile yeniden planlamasından doğar (belgelenmiş bir AI SDK deseni: aynı tool tek turda 5 kez, *"Tool call
ids are different"*). Çağrı-anahtarlı exactly-once — her durable motorunki, bizim varsayılanımız dahil —
bu vakaya tanım gereği kördür. Tool başına opt-in yap, GNL journal anahtarını `toolCallId` yerine
**argümanlardan** türetsin:

```ts
import { gnlTool } from '@gnldev/durable';
import { tool } from 'ai';

const tools = {
  charge: gnlTool(
    tool({ description: 'Siparişi tahsil et', inputSchema: z.object({ orderId: z.string() }), execute: chargeCard }),
    {
      idempotency: 'args',                       // varsayılan: 'call' (toolCallId-anahtarlı, değişmedi)
      // ya da mantıksal anahtarla: idempotencyKey: (input) => input.orderId,
    },
  ),
};
```

Tüm duplicate'ler — aynı adım içindeki eşzamanlı olanlar dahil (hata almak yerine kazananın sonucunu
bekler) — TEK çalıştırmaya iner; kalanlar journal'daki çıktıyı alır. Dedup penceresi varsayılan olarak
run-scoped'tır; `idempotencyWindow: 'cross-run'` ile aynı argümanlar (ya da mantıksal anahtar, ör.
`orderId`) **tüm** run'lar arasında bir kez çalışır — retry'lanan işler ve yeniden tetiklenen agent'lar
dahil. Bu tekrarlanan-toolCallId desenini uçtan uca yeniden üretip engellendiğini gösteren kanıt testi:
`packages/durable/test/args-idempotency.test.ts`.

#### AI SDK drop-in: `withIdempotency` — `runDurable` olmadan
Zaten düz bir `generateText`/`streamText` + `tools` loop'undasın ve `runDurable`'a geçmek istemiyorsan?
Tool haritasını sarmalaman yeter — aynı çağrı noktaları, aynı loop:

```ts
import { withIdempotency, InMemoryJournal } from '@gnldev/durable';
// ya da: const journal = new SqliteStorage('runs.db').runs;

const tools = withIdempotency(rawTools, {
  journal: new InMemoryJournal(),
  // window varsayılanı 'cross-run' → bir orderId hangi çağrı/run'dan gelirse gelsin bir kez tahsil edilir
  // window: 'run', runId: 'order-123',        // dedup'ı tek run'a daralt
  // key: (name, args) => (args as any).orderId, // mantıksal anahtarla dedup
});
```

**Dürüst sınır:** bu katman sana *"aynı argüman iki kez çalışmaz"*ı verir — happy-path dedup ve cross-run
tek-çalıştırma tam çalışır. Tam durability'yi vermez: loop entegrasyonu olmadan blocked/retry/approval
merdiveni (crash-recovery, approval gating) standalone modda suspend etmek yerine **THROW eder**. Bunlar
için `runDurable` gerekir. Çalışan örnek (API key gerekmez): `examples/showcase/src/ai-sdk-idempotency.ts`;
testler: `packages/durable/test/with-idempotency.test.ts`.

| Sadece bizde | Parite (+durable twist) |
|---|---|
| exactly-once tool/model/MCP/RAG · **LLM-aware args-bazlı idempotency** (`idempotency: 'args'` / `idempotencyKey` — modelin aynı çağrıyı yeni `toolCallId` ile yeniden planlamasını dedup'lar) · deterministic replay (opt-in `replay: 'strict'` → `DivergenceError`; varsayılan lenient yalnız uyarır — replay dayatılan kısıt değil, **opt-in güvence**) · time-travel + fork · **deterministik model fallback** (kazanan journal'a yazılır, resume yapışır) · **org-scoped journal** (`withOrg` — organizasyon izolasyonu + exactly-once mirası) · **edge-native**: çekirdek **29,9 KiB gzip**, AI SDK dahil **94,2 KiB gzip** = CF Workers ücretsiz limitinin %3,1'ü (`pnpm --filter @gnldev/showcase bundle` ile ölçülür) · durable queue (heartbeat'li lock renew) · event bus (exactly-once işaretleme + at-least-once teslim) · network-ötesi A2A (opt-in HMAC-SHA256 imza) · idempotent OTEL · cross-run cache · dış-çağrı **zaman aşımları** (`timeouts: {modelStepMs,toolMs,claimTtlMs}` → `StepTimeoutError`) · **fail-closed auth** (production'da provider yoksa kurulum hata verir) · **onay (approval) kararları journal'da first-class** (onaylandı-ama-tool-çalışmadan-crash senaryosunda resume kararı `approvals` parametresi verilmese bile journal'dan uygular) | agent loop · **requestContext DI** (dinamik model/system/tools) · memory (recall/schema-WM/thread/OM) · workflows (evented) · MCP (client+server) · evals (+datasets) · auto-REST/OpenAPI (409/422 resumable sözleşmesi) · processors · RAG (+rerank) · cost ledger |

## Gereksinimler

**Node.js 22.13 veya üstü.** Varsayılan depolama `node:sqlite` kullanıyor; modül 22.5'te bayrak arkasındaydı, import edilebilir hâle 22.13'te geldi —
daha eski bir çalışma zamanında ilk koşu `ERR_UNKNOWN_BUILTIN_MODULE: No such built-in module: node:sqlite` ile başarısız olur.
Node 20 LTS'teyseniz ya yükseltin ya da `journal`'ı `@gnldev/durable/postgres` veya `/redis`'e
yönlendirin. Depo pnpm 10 ile geliştiriliyor ve test ediliyor.

## Hızlı başlangıç (DX)
Paketler npm'e çıkana kadar starter klondan koşulur (dürüst not: `npm create gnl` tek-satırlığı
ancak npm yayınından sonra çalışır):
```bash
git clone https://github.com/Karaca7/gnl-framework.git gnl && cd gnl
pnpm install && pnpm -r build
cd examples && node ../packages/create-gnl/dist/index.js my-agent   # starter (mock model — API key gerekmez)
cd my-agent && pnpm install       # examples/ içinde → @gnldev/* workspace linkiyle çözülür
pnpm dev                          # REST API + Studio Playground (tek port): http://localhost:3000 (+ /studio)
```
npm yayınından sonra: her yerde `npm create gnl my-agent`.
Frontend'den type-safe çağrı:
```ts
import { GnlClient } from '@gnldev/client';                 // veya: '@gnldev/client/react' → useChat
const gnl = new GnlClient({ baseUrl: 'http://localhost:3000' });
const { text } = await gnl.run('assistant', { prompt: 'merhaba' });
for await (const ev of gnl.stream('assistant', { prompt: 'akış' })) { /* text-delta… */ }
```

## Paketler (24)
| Paket | Ne |
|---|---|
| **`@gnldev/durable`** | Çekirdek: `runDurable`/`resumeRun`/`streamDurable` · `durableTool`/`withDurableModel` · journal (memory/**sqlite/postgres/redis**) · `createGnl`+model-router · `createAgentTool` + **dinamik ağ (`runNetwork`, CAS-frozen routing)** · `getRunCost` · `reconstructState`/`forkRun` · run-lock (**atomik takeover: `putIfMatch`**) · `rolloverRun` (dönem devri) · retention (`sweepRuns/sweepLog/sweepThreads`, özyinelemeli `purgeRun`, disk geri kazanımı `compact`) · **`timeouts` (`modelStepMs`/`toolMs`/`claimTtlMs`) → `StepTimeoutError`** |
| **`@gnldev/memory`** | `AgentMemory`: recall (messageRange/threshold/filter/resource-scope) · schema WM + `updateWorkingMemory` tool · thread CRUD/clone · observational memory (Observer/Reflector, pluggable tokenizer) · MessageList |
| **`@gnldev/rag`** | vector store (dev: in-memory · **prod: pgvector**) · **`chunkText`/`chunkDocuments`** (recursive/markdown/character) · **`GraphRag`** (benzerlik-grafı retrieval) · `createRagTool` · `llmReranker` · `SemanticMemory` |
| **`@gnldev/workflow`** | then/parallel/branch · foreach/loop · **`retry` (bildirimsel retry-policy, sayaç journal'da)** · `runResumable` + `sleep`/`waitFor` (evented/scheduled) |
| **`@gnldev/processors`** | piiRedactor · moderationProcessor · toolFilter · **`toolSearch` (semantik tool seçimi, journal'lı)** · tokenLimit · promptInjectionDetector · outputLimit |
| **`@gnldev/evals`** | **16 hazır scorer** (faithfulness/hallucination/…) · llmJudge · `scoreRun` · `evalDataset` (resumable) · **`createDatasetsManager`** (versiyon geçmişi + deney `compare`) |
| **`@gnldev/mcp`** | MCP client (`mcpTools`) **+ server** (`createMcpServer`, server-side exactly-once) |
| **`@gnldev/server`** | `createRestApi` + OpenAPI · **fail-closed auth** (production'da provider yoksa kurulum hata verir; bilinçli açık erişim `allowOpenAccess: true`) · **409/422 resumable sözleşmesi** (blok/limit hataları `BLOCKED_ERROR_CODES` tek kaynağından `resumable`/`retry` ayrımıyla döner) |
| **`@gnldev/otel`** | `exportRunToOtlp` + **`otlpPresets`** (Langfuse/Braintrust/Honeycomb/Datadog/Collector + jenerik API-key OTLP) · **canlı mod** (`@gnldev/otel/live`) |
| **`@gnldev/queue`** | durable job queue + worker · **heartbeat'li lock renew** (uzun handler'larda takeover'ı önler) + opt-in boş-poll backoff |
| **`@gnldev/events`** | event bus (fan-out) — exactly-once işaretleme + at-least-once teslim; handler idempotent olmalı · opt-in boş-poll backoff |
| **`@gnldev/a2a`** | uzak agent (network-ötesi exactly-once) · **opt-in HMAC-SHA256 imzalı istek** (`createA2ATool({ secret })` ↔ `createRestApi({ a2aSecret })`, timestamp penceresiyle replay direnci) |
| **`@gnldev/cache`** | cross-run cache |
| **`@gnldev/studio`** | inspector **+ Playground**: agent seç→prompt→streaming yanıt→onay · time-travel/fork + cost/trace/metrics/diff · admin↔API ayrımı + rol auth |
| **`@gnldev/client`** | type-safe REST/SSE client (framework-agnostik core) + React hook'ları (`@gnldev/client/react`: `useGnlAgent`/`useChat`) |
| **`@gnldev/cli`** | proje: `gnl init [dir] [--features a,b,c] [--host hono\|node\|express\|fastify\|koa\|nest] [--template minimal\|full] [--e2e] [--yes]` (starter'lar — **`full`, `idempotency: 'args'` tool'u + tekrarlanan-toolCallId desenini yeniden üreten e2e testi taşır**) / `add <idempotency-tool\|rag\|mcp\|memory\|workflow\|auth>` / `dev` / `studio` · inceleme: `runs`/`run`/`inspect` (**terminalde zaman yolculuğu**) · operasyon: `fork`/`resume`/`sweep`/`rm` (hepsi doğrudan `@gnldev/durable`'ın kendi export'larına bağlı, hiçbiri yeniden implement edilmedi) · **bir runtime bağımlılığı** (`tsx`, `gnl.config.ts` yüklemek için; elle yazılmış ANSI/tablo, chalk/ora/commander yok) · `create-gnl` (`npm create gnl`) |

## Örnekler (`examples/`)
- **`showcase`** — paketleri kendi kendini doğrulayan tek dosya: `pnpm --filter @gnldev/showcase demo` → 22 bölüm 22/22 ✓ (mock model, API key gerekmez) · `bench` (overhead ölçer)
- **`app`** — **Durable AI Support Desk** (web UI + API): `pnpm --filter @gnldev/app start` → :3100 (UI) + :3100/studio (ops). Ticket→mesaj→onay→exactly-once iade + queue/events/otel.
- **`react-client`** — `@gnldev/client/react` demosu (`useChat` + streaming + onay), API key'siz echo backend. `pnpm --filter @gnldev/react-client-example server` + `… dev`.

## Tedarik zinciri hijyeni
Kurduğun bir bağımlılık, makinende ve derlemende kod çalıştırır. GNL'in bu repoda bugün
doğrulanabilir duruşu:
- **Sıfır install script** — hiçbir pakette `postinstall`/`preinstall` yok.
- **Minimal bağımlılık yüzeyi** — çekirdeğin (`@gnldev/durable`) tam olarak **bir** runtime bağımlılığı var
  (`superjson`); storage sürücüleri (`pg`, `ioredis`) açıkça opt-in olduğun opsiyonel peer'lar.
- **İmzalı, provenance-attested yayın** (`npm publish --provenance`) yayın planıdır — CI dışında yayın olmaz.

## Geliştirme
```bash
pnpm install
pnpm -r build && pnpm -r typecheck && pnpm test   # 2000+ test

# gerçek backend entegrasyon testi (opsiyonel):
docker-compose up -d
GNL_INTEGRATION=1 npx vitest run packages/durable/test/integration-real.test.ts
docker-compose down
```
TypeScript strict · 0 `@ts-ignore` (tip kaçışları sınırlı tutuldu; sınır/serileştirme noktalarında bir miktar `any`) · bağımlılık: `superjson` (+ opsiyonel hono/opentelemetry). Peer: `ai`, `zod`. **Telemetri/phone-home yok.**

## Deployment
gnl tamamen Hono tabanlı → Node deploy birkaç satır:
```ts
import { createRestApi } from '@gnldev/server';
import { serve } from '@hono/node-server';
serve({ fetch: createRestApi(config).fetch, port: Number(process.env.PORT ?? 3000) });
```
**Journal uyarısı:** serverless/edge runtime'larda `node:sqlite` çalışmaz → ağ-tabanlı journal kullanın (`@gnldev/durable/postgres` veya `/redis`, Cloudflare'de D1). `SqliteStorage` yalnız uzun-ömürlü Node süreçleri içindir.

## Dürüst konumlandırma
"Tam-donanımlı bir agent framework alternatifi" değil; **AI SDK için durability/correctness katmanı**: sağlam bir çekirdek (`@gnldev/durable`) +
onun garantilerini miras alan değişken olgunlukta uydu paketler. Tipik tam-donanımlı bir agent framework'ün temel yeteneklerinin çoğunu kapsar
(memory/workflow/rag/mcp/processors/eval…) ama bunu **çağrı-bazında exactly-once effect + deterministic replay**
üstüne kurar. "Exactly-once" burada mutlak bir fiziksel garanti değil — **çağrı-bazlı dedup + güvenli-varsayılan**
demektir: aynı `toolCallId` bir daha çalışmaz, sonucu belirsiz kalan çağrı `recover()`/`idempotencyKey` ile
sağlayıcıya kadar takip edilir, hâlâ belirsizse sistem **sessizce tekrar etmek yerine bloklanıp onay ister**
(yeniden planlanmış bir çağrının sızmasını engelleyen sentinel `packages/durable/test/blocked-sentinel.test.ts`'te,
recover merdiveni `packages/durable/test/crash-window.test.ts`'te) — opak step-snapshot'lı bir durable agent'ın vermediği budur. Bu tür framework'ler
daha geniş/olgun (voice/deployer/editor/auth — bizde bilinçli pas) ama hiçbir özelliği bu garantilerle gelmiyor.
Bizim kozumuz **correctness**; ödeme/finans/transaksiyonel ve uzun-koşan/dağıtık iş yüklerinde belirleyici.
## Neden `WorkflowAgent` değil?

Yerinde bir soru, ve cevaplanması en önemli olanı: AI SDK ajanları için dayanıklılık artık SDK'da bir
boşluk değil. Vercel, `@ai-sdk/workflow` içinde
[`WorkflowAgent`](https://vercel.com/kb/guide/what-is-workflowagent) ve Workflow DevKit içinde
[`DurableAgent`](https://workflow-sdk.dev) sunuyor — aynı ajan döngüsü, ama her araç çağrısı
`'use step'` ile dayanıklı bir adıma dönüşüyor: hata alınca yeniden deniyor, süreç sınırından sağ
çıkıyor, `needsApproval` ile askıya alınıp günler sonra devam edebiliyor. Vercel üzerindeysen
yönetilen kalıcılık, gözlemlenebilirlik ve çoklu bölge işletmen gereken hiçbir depolama olmadan
geliyor. Bu gerçek bir ürün ve bu projenin yaptığının çoğuyla örtüşüyor.

**Fark tek eksende: yan etkinin iki kez olmamasından kim sorumlu.**

`WorkflowAgent` başarısız araç çağrısını otomatik yeniden deniyor — varsayılan üç deneme. Etkiyi
tekilleştirmiyor ve tekilleştirdiğini de iddia etmiyor: Vercel'in kendi yönlendirmesi, adımın
`stepId`'sini dış API'ye
[idempotency key](https://workflow-sdk.dev/cookbook/common-patterns/idempotency) olarak geçirmen —
böylece kopyayı *Stripe* birleştiriyor. Sağlam bir kalıp, ve sana üç şey bırakıyor:

- **API'nin idempotency key desteklemesi gerekir.** Stripe destekliyor. Kurum içi bir muhasebe
  servisi genelde desteklemiyor.
- **Her çağrı yerinde elle bağlanıyor.** Birini atlarsan gürültülü biçimde bozulmuyor; sadece bir gün
  iki kez çekiyor.
- **`stepId` konumsal.** Model *aynı iş eylemini* yeni bir araç çağrısı olarak yeniden planlarsa —
  belgelenmiş bir AI SDK kalıbı — adım farklı olur, dolayısıyla anahtar farklı olur, dolayısıyla etki
  tekrar gerçekleşir. [`idempotency: 'args'`](./packages/durable/README.md) tam bu durum için var.

gnl tekilleştirmeyi journal'a koyuyor: varsayılan olarak `toolCallId` ile, opt-in yaparsan argüman
hash'i veya mantıksal bir anahtarla, istersen koşular arası — ve sonuç gerçekten bilinemediğinde
(etki ile kaydı arasındaki çöküş) iki yönden birine tahmin yürütmek yerine **durup insana soruyor.**
Doğruluk varsayılan, her çağrı yerinde ayrı bir yükümlülük değil. Diğer pratik fark: bu, zaten
işlettiğin depolamanın üstünde bir kütüphane (`node:sqlite`, Postgres, Redis, kendi adaptörün),
üzerine dağıtım yapacağın bir platform değil.

**Workflow grafiği içinde ajanlar.** `@gnldev/workflow` grafiği zaten sunuyor — `then` / `branch` /
`parallel` / `foreach` / `dowhile`, artı `sleep`, `waitFor` ve askıya alma/devam — ve `Step` iki
alanlı bir arayüz olduğu için ajan yeni bir API'ye gerek kalmadan düğüm oluyor:

```ts
import { workflow, step, type StepCtx } from '@gnldev/workflow';
import { runDurable } from '@gnldev/durable';

const triage = step('triage', async (input: { ticket: string }, ctx: StepCtx) => {
  const res = await runDurable({
    runId: `${ctx.keyPrefix ?? ''}${ctx.runId}:triage`,   // ← adımdan türet, aşağıya bak
    journal: ctx.journal as never, model, tools, prompt: 'bu bileti sınıflandır',
  } as never);
  return { ...input, label: (res as { text: string }).text };
});

const refundFlow = step('refund', async (i: { label: string }) => i);
const closeTicket = step('close', async (i: { label: string }) => i);

workflow<{ ticket: string }>()
  .then(triage)
  .branch((i) => i.label === 'refund', refundFlow, closeTicket);
```

Taşıyıcı satır `runId`. Adımın kimliğinden türetilirse devam aynı ajan koşusunu replay eder; her
çağrıda uydurulursa yenisini başlatır — ve adımın *içinde*, araç çalıştıktan ama grafik hiçbir şey
kaydetmeden önce olan bir çöküş kartı iki kez çeker. Bu iddia değil, ölçüm:
`packages/durable/test/agent-as-workflow-step.test.ts` bu iç içe geçmeyi kapsıyor ve o tek satırı
bozmak çekim sayısını 1'den 2'ye çıkarıyor. Bilinmesi gereken bir asimetri: `.foreach` `Step` değil
fonksiyon aldığı için, fan-out içindeki ajan aynı yardımcıyı yeniden kullanmak yerine yerinde
çağrılıyor.

---



---

## Dokümantasyon

- **[docs/GUIDE.tr.md](./docs/GUIDE.tr.md)** — tam rehber: nedir, bir koşu nasıl işler, journal'ın
  anahtar şeması, depolama portları ve bunların ardındaki tasarım ödünleri. Motoru sadece çağırmak
  değil anlamak istiyorsanız buradan başlayın.
- **[docs/GUIDE.md](./docs/GUIDE.md)** — aynı rehberin İngilizcesi.
- **[examples/incident-proofs](./examples/incident-proofs)** — gerçek çift-yan-etki olaylarının
  yeniden üretimi ve bu çerçevenin her birinde ne yaptığı.
- **[examples/stripe-idempotency](./examples/stripe-idempotency)** — sahte Stripe'a karşı
  sağlayıcı-taraflı exactly-once: journal'dan sağlayıcıya taşınan aynı anahtar.
- **[examples/showcase](./examples/showcase)** — API anahtarı gerektirmeden paketleri uçtan uca
  koşturan, kendini doğrulayan tek dosya: `pnpm --filter @gnldev/showcase demo`.

## Katkı

Pull request'lere açığız. Önce **[CONTRIBUTING.md](./CONTRIBUTING.md)**'i okuyun — derleme, bir
değişikliğin geçmesi gereken kontroller ve tek satırlık **[CLA](./CLA.md)** kabulü orada. CLA,
projenin lisansının ileride her katkıcıyı tek tek bulmak zorunda kalmadan evrilebilmesini sağlıyor.

## Güvenlik

Bir açık için lütfen herkese açık issue açmayın. **[SECURITY.md](./SECURITY.md)** açığı GitHub
üzerinden özel olarak nasıl bildireceğinizi ve kapsamı anlatıyor — dayanıklılık, organizasyonlar
arası izolasyon ve onay kapıları önce saldırılmaya değer garantiler.

## Lisans

[Apache-2.0](./LICENSE) — © 2026 Karaca Yılmaz.
