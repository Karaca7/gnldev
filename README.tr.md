# GNL — Correct Durable Agents

[English](./README.md) · **Türkçe**

**Vercel AI SDK üstüne ince bir "correctness katmanı" — server kurmadan durable execution.** AI SDK'nın
agentic loop'unu (`generateText`/`streamText` + `tools`) değiştirmeden, iki sarmalayıcı + bir journal ile
ekler: **yan etkili bir tool çağrısı ASLA sessizce iki kere olmaz.** Bunun kesin anlamı **"exactly-once
effect"**tir — çağrı-bazlı dedup + güvenli-varsayılan: `recover()`/`idempotencyKey` ile garanti sağlayıcının
kendisine kadar uzanır, belirsizlikte (crash sonrası sonuç bilinmiyorsa) sessiz tekrar yerine **blok + onay**.
AI SDK biliyorsan bunu da biliyorsun.

```ts
import { runDurable } from '@gnl/durable';
import { SqliteStorage } from '@gnl/durable/sqlite';

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
const tools = {
  charge: {
    idempotency: 'args',                       // varsayılan: 'call' (toolCallId-anahtarlı, değişmedi)
    // ya da mantıksal anahtarla: idempotencyKey: (args) => args.orderId,
    execute: chargeCard,
  },
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
import { withIdempotency, InMemoryJournal } from '@gnl/durable';
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
| exactly-once tool/model/MCP/RAG · **LLM-aware args-bazlı idempotency** (`idempotency: 'args'` / `idempotencyKey` — modelin aynı çağrıyı yeni `toolCallId` ile yeniden planlamasını dedup'lar) · deterministic replay (opt-in `replay: 'strict'` → `DivergenceError`; varsayılan lenient yalnız uyarır — replay dayatılan kısıt değil, **opt-in güvence**) · time-travel + fork · **deterministik model fallback** (kazanan journal'a yazılır, resume yapışır) · **org-scoped journal** (`withOrg` — organizasyon izolasyonu + exactly-once mirası) · **edge-native**: çekirdek **16,4 KiB gzip**, AI SDK dahil **62,2 KiB gzip** = CF Workers ücretsiz limitinin %2,0'ı (`pnpm bundle` ile ölçülür; tipik tam-donanımlı bir agent framework'ün build çıktısı ~17,58 MiB raw) · durable queue (heartbeat'li lock renew) · event bus (exactly-once işaretleme + at-least-once teslim) · network-ötesi A2A (opt-in HMAC-SHA256 imza) · idempotent OTEL · cross-run cache · dış-çağrı **zaman aşımları** (`timeouts: {modelStepMs,toolMs,claimTtlMs}` → `StepTimeoutError`) · **fail-closed auth** (production'da provider yoksa kurulum hata verir) · **onay (approval) kararları journal'da first-class** (onaylandı-ama-tool-çalışmadan-crash senaryosunda resume kararı `approvals` parametresi verilmese bile journal'dan uygular) | agent loop · **requestContext DI** (dinamik model/system/tools) · memory (recall/schema-WM/thread/OM) · workflows (evented) · MCP (client+server) · evals (+datasets) · auto-REST/OpenAPI (409/422 resumable sözleşmesi) · processors · RAG (+rerank) · cost ledger |

## Hızlı başlangıç (DX)
Paketler npm'e çıkana kadar starter klondan koşulur (dürüst not: `npm create gnl` tek-satırlığı
ancak npm yayınından sonra çalışır):
```bash
git clone https://github.com/Karaca7/gnldev.git gnl && cd gnl
pnpm install && pnpm -r build
cd examples && node ../packages/create-gnl/dist/index.js my-agent   # starter (mock model — API key gerekmez)
cd my-agent && pnpm install       # examples/ içinde → @gnl/* workspace linkiyle çözülür
pnpm dev                          # REST API + Studio Playground (tek port): http://localhost:3000 (+ /studio)
```
npm yayınından sonra: her yerde `npm create gnl my-agent`.
Frontend'den type-safe çağrı:
```ts
import { GnlClient } from '@gnl/client';                 // veya: '@gnl/client/react' → useChat
const gnl = new GnlClient({ baseUrl: 'http://localhost:3000' });
const { text } = await gnl.run('assistant', { prompt: 'merhaba' });
for await (const ev of gnl.stream('assistant', { prompt: 'akış' })) { /* text-delta… */ }
```

## Paketler (17)
| Paket | Ne |
|---|---|
| **`@gnl/durable`** | Çekirdek: `runDurable`/`resume`/`stream` · `durableTool`/`withDurableModel` · journal (memory/**sqlite/postgres/redis**) · `createGnl`+model-router · `agentAsTool` + **dinamik ağ (`runNetwork`, CAS-frozen routing)** · `getRunCost` · `reconstructState`/`forkRun` · run-lock (**atomik takeover: `putIfMatch`**) · `rolloverRun` (dönem devri) · retention (`sweepRuns/sweepLog/sweepThreads`, özyinelemeli `purgeRun`, disk geri kazanımı `compact`) · **`timeouts` (`modelStepMs`/`toolMs`/`claimTtlMs`) → `StepTimeoutError`** |
| **`@gnl/memory`** | `GnlMemory`: recall (messageRange/threshold/filter/resource-scope) · schema WM + `updateWorkingMemory` tool · thread CRUD/clone · observational memory (Observer/Reflector, pluggable tokenizer) · MessageList |
| **`@gnl/rag`** | vector store (dev: in-memory · **prod: pgvector**) · **`chunkText`/`chunkDocuments`** (recursive/markdown/character) · **`GraphRag`** (benzerlik-grafı retrieval) · `createRagTool` · `llmReranker` · `SemanticMemory` |
| **`@gnl/workflow`** | then/parallel/branch · foreach/loop · **`retry` (bildirimsel retry-policy, sayaç journal'da)** · `runResumable` + `sleep`/`waitFor` (evented/scheduled) |
| **`@gnl/processors`** | piiRedactor · moderation · toolFilter · **`toolSearch` (semantik tool seçimi, journal'lı)** · tokenLimit · promptInjection · outputLimit |
| **`@gnl/evals`** | **8 hazır scorer** (faithfulness/hallucination/…) · llmJudge · `scoreRun` · `evalDataset` (resumable) · **`createDatasetsManager`** (versiyon geçmişi + deney `compare`) |
| **`@gnl/mcp`** | MCP client (`mcpTools`) **+ server** (`createMcpServer`, server-side exactly-once) |
| **`@gnl/server`** | `createRestApi` + OpenAPI · **fail-closed auth** (production'da provider yoksa kurulum hata verir; bilinçli açık erişim `allowOpenAccess: true`) · **409/422 resumable sözleşmesi** (blok/limit hataları `BLOCKED_ERROR_CODES` tek kaynağından `resumable`/`retry` ayrımıyla döner) |
| **`@gnl/otel`** | `exportRunToOtlp` + **`otlpPresets`** (Langfuse/Braintrust/Honeycomb/Datadog/Collector + jenerik API-key OTLP) · **canlı mod** (`@gnl/otel/live`) |
| **`@gnl/queue`** | durable job queue + worker · **heartbeat'li lock renew** (uzun handler'larda takeover'ı önler) + opt-in boş-poll backoff |
| **`@gnl/events`** | event bus (fan-out) — exactly-once işaretleme + at-least-once teslim; handler idempotent olmalı · opt-in boş-poll backoff |
| **`@gnl/a2a`** | uzak agent (network-ötesi exactly-once) · **opt-in HMAC-SHA256 imzalı istek** (`createA2ATool({ secret })` ↔ `createRestApi({ a2aSecret })`, timestamp penceresiyle replay direnci) |
| **`@gnl/cache`** | cross-run cache |
| **`@gnl/studio`** | inspector **+ Playground**: agent seç→prompt→streaming yanıt→onay · time-travel/fork + cost/trace/metrics/diff · admin↔API ayrımı + rol auth |
| **`@gnl/client`** | type-safe REST/SSE client (framework-agnostik core) + React hook'ları (`@gnl/client/react`: `useGnlAgent`/`useChat`) |
| **`@gnl/cli`** | proje: `gnl init [--template minimal\|full] [--e2e]` (starter'lar — **`full`, `idempotency: 'args'` tool'u + tekrarlanan-toolCallId desenini yeniden üreten e2e testi taşır**) / `add <memory\|rag\|mcp\|workflow\|auth>` / `dev` / `studio` · inceleme: `runs`/`run`/`inspect` (**terminalde zaman yolculuğu**) · operasyon: `fork`/`resume`/`sweep`/`rm` (hepsi doğrudan `@gnl/durable`'ın kendi export'larına bağlı, hiçbiri yeniden implement edilmedi) · **sıfır yeni runtime bağımlılığı** (elle yazılmış ANSI/tablo, chalk/ora/commander yok) · `create-gnl` (`npm create gnl`) |
| **`@gnl/deploy`** | `nodeAdapter`/`edgeAdapter` · `bundleApp` (esbuild, edge hedefi) · **`deployTargets`** (Cloudflare/Vercel/Netlify üreticileri) |

## Örnekler (`examples/`)
- **`showcase`** — 14 paketi kendi kendini doğrulayan tek dosya: `pnpm --filter @gnl/showcase demo` → 22 bölüm 22/22 ✓ (mock model, API key gerekmez) · `bench` (overhead ölçer)
- **`app`** — **Durable AI Support Desk** (web UI + API): `pnpm --filter @gnl/app start` → :3100 (UI) + :3100/studio (ops). Ticket→mesaj→onay→exactly-once iade + queue/events/otel.
- **`react-client`** — `@gnl/client/react` demosu (`useChat` + streaming + onay), API key'siz echo backend. `pnpm --filter @gnl/react-client-example server` + `… dev`.

## Tedarik zinciri hijyeni
Kurduğun bir bağımlılık, makinende ve derlemende kod çalıştırır. GNL'in bu repoda bugün
doğrulanabilir duruşu:
- **Sıfır install script** — hiçbir pakette `postinstall`/`preinstall` yok.
- **Minimal bağımlılık yüzeyi** — çekirdeğin (`@gnl/durable`) tam olarak **bir** runtime bağımlılığı var
  (`superjson`); storage sürücüleri (`pg`, `ioredis`) açıkça opt-in olduğun opsiyonel peer'lar.
- **İmzalı, provenance-attested yayın** (`npm publish --provenance`) yayın planıdır — CI dışında yayın olmaz.

## Geliştirme
```bash
pnpm install
pnpm -r build && pnpm -r typecheck && pnpm test   # 230+ test

# gerçek backend entegrasyon testi (opsiyonel):
docker-compose up -d
GNL_INTEGRATION=1 npx vitest run packages/durable/test/integration-real.test.ts
docker-compose down
```
TypeScript strict · 0 `@ts-ignore` (tip kaçışları sınırlı tutuldu; sınır/serileştirme noktalarında bir miktar `any`) · ~920KB toplam dist · bağımlılık: `superjson` (+ opsiyonel hono/opentelemetry). Peer: `ai`, `zod`. **Telemetri/phone-home yok.**

## Deployment
gnl tamamen Hono tabanlı → Node deploy birkaç satır:
```ts
import { createRestApi } from '@gnl/server';
import { nodeAdapter } from '@gnl/deploy';                // ince @hono/node-server sarmalı
nodeAdapter(createRestApi(config), { port: process.env.PORT });
```
**Journal uyarısı:** serverless/edge runtime'larda `node:sqlite` çalışmaz → ağ-tabanlı journal kullanın (`@gnl/durable/postgres` veya `/redis`, Cloudflare'de D1). `SqliteStorage` yalnız uzun-ömürlü Node süreçleri içindir. Vercel/Cloudflare/Netlify hedefleri hazır: `deployTargets` (bkz. [`@gnl/deploy`](packages/deploy)).

## Dürüst konumlandırma
"Tam-donanımlı bir agent framework alternatifi" değil; **AI SDK için durability/correctness katmanı**: sağlam bir çekirdek (`@gnl/durable`) +
onun garantilerini miras alan değişken olgunlukta uydu paketler. Tipik tam-donanımlı bir agent framework'ün temel yeteneklerinin çoğunu kapsar
(memory/workflow/rag/mcp/processors/eval…) ama bunu **çağrı-bazında exactly-once effect + deterministic replay**
üstüne kurar. "Exactly-once" burada mutlak bir fiziksel garanti değil — **çağrı-bazlı dedup + güvenli-varsayılan**
demektir: aynı `toolCallId` bir daha çalışmaz, sonucu belirsiz kalan çağrı `recover()`/`idempotencyKey` ile
sağlayıcıya kadar takip edilir, hâlâ belirsizse sistem **sessizce tekrar etmek yerine bloklanıp onay ister**
(H7/H9, bkz. `docs/CORE-HARDENING.md`) — opak step-snapshot'lı bir durable agent'ın vermediği budur. Bu tür framework'ler
daha geniş/olgun (voice/deployer/editor/auth — bizde bilinçli pas) ama hiçbir özelliği bu garantilerle gelmiyor.
Bizim kozumuz **correctness**; ödeme/finans/transaksiyonel ve uzun-koşan/dağıtık iş yüklerinde belirleyici.
