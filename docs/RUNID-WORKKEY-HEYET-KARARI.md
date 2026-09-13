# Koşum Kimliği Kararı: workKey Beyanı + Türetilmiş runId (B+)

**Durum: UYGULANDI (6/6 paket, 12 Eylül 2026) — denetim turu ve prod-test göçü bekliyor.**
Bloke edici şartların tamamı uygulamada karşılandı; sapmalar paket raporlarında işaretli
(başlıcaları: tür-önekli entityName `agent:`/`wf:`/`net:`; `#fork-<n>` üçüncü ek olarak doğdu —
fork/rollover/replay'in üç varsayılan hedefinin de türetilmiş kaynakta kırık olduğu ÖLÇÜLDÜ;
onConflict/onReuse tipte alan olarak YAŞAMIYOR [A-heyeti rafinesi]; chat iki-rejimli: özneli
istek türetilmiş kimlik alır, anonim istek ham türetmede kalır; Idempotency-Key artık workKey
alias'ı). Karar heyeti (3 üye, bağımsız web araştırmalı) şartlı onay vermişti. Tarih: 11 Eylül 2026.
Süreç: 3 kod-fırtınası merceği → 4 dış araştırma kolu (durable-execution, desen literatürü,
ajan framework'leri, üretim postmortem'leri) → 3 üyeli karar heyeti (karşı-avukat / uygulama
gerçekçisi / sözleşme hakemi).

---

## 1. Karar (tek paragraf)

Çağıranın verdiği string, journal'ın ham anahtar öneki olmaktan çıkar. Dışarıya tek kavram kalır:
**`workKey`** — "bu işin adı bu" beyanı. Motor gerçek kimliği kendisi türetir ve journal'ın anahtar
öneki o olur. Beyan edilen ad `:input` kaydında birinci sınıf, sorgulanabilir alan olarak saklanır
ve ekranlarda gösterilir. Kullanıcı deneyimi değişmez; değişen şey, dış string'in iç anahtara
çıplak elle dokunamaması.

## 2. Neden (ölçülmüş sorunlar)

Kök hastalık: **dış string = iç anahtar.** Bu kökten çıkan ve bu turda ölçülen dört ayrı bug sınıfı:

1. **Rezerve ad çakışması** — `runId: "mem"` → `purgeRun('mem')` → `del('mem:')` → tüm
   kullanıcıların thread hafızası silinir (güvenlik taramasında KRİTİK bulgu; `assertRunIdSafe`
   yamasıyla kapatıldı — yama, kökü değil semptomu tutuyor).
2. **Önek-iç-içe kimlikler** — `conv` ve `conv:msg1` aynı anda yaşayabilir; `purgeRun('conv')`
   komşunun kayıtlarını yer. Chat türetimi (`chatId:msgId`) bu şekli fiilen üretiyor.
3. **Ayrıştırma belirsizliği** — runId'de `:tool:` / `:model:` yasak değil; istemci kontrollü
   id'lerle sahte journal girdisi gibi ayrışan anahtarlar üretilebilir.
4. **PII sızıntısı** — `musteri-ahmet-siparis` gibi id'ler URL'lerde, header'larda, loglarda gezer.
   Anahtar-içi PII, `purgeResource` ile geri çağrılamaz (değer-içi PII çağrılır).

Sektör kıyası: kullanıcı kimliği ile depolama kimliğini ayırmayan büyük sistem kalmadı (tek
istisna DBOS — o da global teklik yükünü kullanıcıya itiyor). Ajan kategorisinde ise dedup vaadi
hiç yok; büyük graf-framework'lerinden biri bu yükü geliştiriciye devrettiğini dokümanına açıkça yazar.

## 3. Türetme şeması (heyet-düzeltmeli son hali)

```
runId = "run1_" + hex( sha256( tuple([
          "gnl.run.v1",        // domain + sürüm etiketi — HASH'İN İÇİNDE (dışında değil)
          agentName,           // ZORUNLU (heyet şartı 2a — iki ajanın aynı workKey'i çakışamaz)
                               // SAPMA: uygulamada TÜR ÖNEKLİ gelir — `agent:<ad>` / `wf:<ad>`.
                               // Sebep: bir iş akışı ile bir ajan aynı registry adını taşıyabilir;
                               // öneksiz `pay` boru hattı ile `pay` ajanı TEK id türetirdi.
          scopeKind,           // 'resource' | 'org'
          scopeValue,          // resourceId | orgId | '~deployment' (bkz. §10.2)
          workKey,             // çağıranın beyanı
        ]) ) )[0..32]          // 128 bit — 10 yıl × yıllık 10⁹ koşumda çakışma ~1.5×10⁻¹⁹
```

**Tuple kodlaması pazarlık edilemez.** Naif string birleştirme (`scope + workKey`) enjektif
değildir: `("a","b:c")` ile `("a:b","c")` aynı hash'i üretir. Bu sınıf 2026'da iki gerçek CVE
üretti (CVE-2026-76581, CVSS 9.8 — sınır kaydırmayla kimliksiz admin; CVE-2026-71326 — Traefik,
resmî düzeltme kelimesi kelimesine "length prefix"). Standart: NIST SP 800-185 TupleHash deseni —
alan başına uzunluk-önek + alan sayısı (arity) + domain etiketi. Uygulamada `hash.ts`'teki mevcut
`stableStringify` (JSON dizi kodlaması enjektiftir) yeterli; SHA-3 bağımlılığı alınmaz:

```ts
sha256(stableStringify(["gnl.run.v1", agentName, scopeKind, scopeValue, workKey]))
```

**Sürüm etiketi hash'in içinde.** `run1_` önekini dıştan yapıştırmak yetmez; formül değişirse
`gnl.run.v2` + `run2_` doğar, eski kayıtlar okunmaya devam eder. Versiyonsuz hash'in belgeli
bedeli: git'in SHA-1→SHA-256 geçişi 5+ yıldır bitmedi; argo-rollouts versiyonsuz `ComputeHash`
değişimi yüzünden üretimde kesinti yaşadı; Kubernetes FNV-32 çakışmasını genişletemeyip kalıcı
`collisionCount` API yarası ekledi.

**16 hex ASLA kullanılmaz** (`argsHash`'in kesimi dedup penceresi içindir; runId çakışması kimlik
gaspıdır — farklı risk sınıfı, farklı bütçe: 32 hex).

## 4. Yürütme ekseni: `run1_<hash>#<n>` (heyet şartı 3)

"Aynı işin bilinçli ikinci yürütmesi" birinci sınıf kavram olur: `run1_<hash>` = yürütme #1;
`run1_<hash>#2` = aynı işin ikinci yürütmesi. `#` yalnız motor basar; ham yüzeyde rezervedir.

Gerekçe (karşı-avukat, iki kanıtla):
- CI dünyasında build'lerin **%3,2'si** yeniden koşuluyor (ACM ölçümü) — kenar vaka değil.
- GNL'nin kendi içinde bu kararın yasaklarını çiğneyen iki yol zaten var: `rollover.ts:55-64`
  `${base}@${n}` üretir (hash'siz string bizim uzayımızda), `regression.ts:296` replay id'sine
  **zaman gömer** (reddettiğimiz desen). İkisi de bu eksene taşınır: rollover `#<n>`'i kullanır,
  replay eki `#replay-<seq>` biçimine geçer (deterministik sayaç; zaman damgası kalkar).
  **SAPMA:** bu taşınma yalnız `run1_` kaynaklı koşumlar için uygulandı — ham kaynaklı koşum
  `@N`/`:replay:<seq>` yazımını korur; `#` yalnız `run1_` içinde geçerlidir (iki-rejim, §7 ile tutarlı).

Ters eşleme (id → workKey) `#` ekini kapsar. `onReuse: 'allow'` gelecekte bu eksene yazılır.

## 5. Politika eksenleri (adlar bugünden, davranış değişikliği yok)

```ts
onConflict: 'reject',   // aynı anahtar, iş ŞU AN koşuyor  → 409 run_busy + Retry-After (bugünkü davranış)
onReuse:    'replay',   // aynı anahtar, iş BİTMİŞ         → kayıtlı cevap döner (bugünkü davranış)
```

- v1'de her eksenin TEK değeri kabul edilir; diğer değerler (`join`, `takeover`, `reject`,
  `allow`) config anında **throw** (emsal: `sideEffectDuplicates` config-throw kalıbı).
  Var olmayan değeri dokümanda göstermek vaat ihlalidir; eksen adını doğru koymak yarın değer
  eklemeyi kırılmasız yapar.
- **SAPMA:** `onConflict`/`onReuse` uygulamada **tipte yok** — ne `RunOptions`'ta ne config'te bir
  alan olarak duruyorlar. Yukarıdaki kod bloğu davranışı adlandırıyor, API'yi değil: tek değerli bir
  enum yazmak, ayarlanabilir olmayan bir şeyi ayarlanabilir göstermek olurdu. Adlar bu belgede ve
  README'lerin ikinci-çağrı tablosunda yaşıyor; ikinci değer geldiği gün alan da gelir.
- `'replay'` asimetrisi dipnot değil madde: **başarısız biten koşunun döndürülecek sonucu yoktur;
  aynı workKey yeniden koşabilir.** (Trigger.dev "failed run releases the key" + Temporal
  `AllowDuplicateFailedOnly` emsalleri.)
- İki eksen ayrımının gerekçesi: Temporal tek enum'la başlayıp `TerminateIfRunning`'i yanlış
  eksene koydu ve kendi doküman issue'sunda itiraf etti (temporalio/documentation#2280).
- Üçüncü çarpışma sınıfı adını korur: `strictInput` (aynı anahtar, farklı girdi → 409).
  **`run1_` uzayında zorunludur, opt-out yok** (heyet şartı 1) — çekirdek `assertRunAdmissible`
  bu uzayda parmak izini koşulsuz doğrular. Hata metni workKey-farkındadır; "use a fresh runId"
  tavsiyesi kalkar (kullanıcı o id'yi seçmedi ki tazeleyebilsin).

## 6. workScope ve çekirdek doğrulama (heyet şartı 2)

```ts
agent: { workScope: 'resource' }   // varsayılan: kullanıcının işi kullanıcıya kapsanır
agent: { workScope: 'org' }        // org-geneli iş (cron, mutabakat): tetikleyen kim olursa olsun tek iş
```

- `'resource'` + resourceId yok → **config/çağrı anında throw** (fail-closed). XID'in fail-open'ı
  burada yetmez: XID bir soruyu kaybeder, workKey koşumu yanlış adrese düşürür.
- resourceId yalnız hash'e girmekle kalmaz; **motor çekirdeğinde** (`assertRunAdmissible`)
  eşitliği doğrulanır. HTTP katmanındaki `ownershipDenied`'a güvenilemez — koşulsuz değil ve
  gömülü (server'sız) kullanımda hiç yok. Karşı-avukatın kanıtladığı sessiz senaryo: yanlış
  `'org'` seçiminde iki müşteriden B, A'nın cevabını alıyordu ve ÜÇ kapının üçü de görmüyordu.
- Hatanın asimetrisi tasarımın gerekçesi: `'org'` yönündeki yanlış seçim SESSİZ ve tehlikeli
  (veri sızıntısı), `'resource'` yönündeki yanlış seçim GÜRÜLTÜLÜ ve ucuz (iş iki kez koşar).
  Ajan adının hash'e zorunlu girmesi bu yüzden enum'a üçüncü değer eklemekten üstün.
- Ajan adının bedeli dürüstçe: ajanı yeniden adlandırmak, yarım işlerin resume'unu koparır.
  Yayın öncesi kabul edilebilir; dokümana yazılır ("ajan adı kimliğin parçasıdır").

## 7. Yüzey tablosu (sözleşme hakeminin 1. boşluğu — karar)

| Yüzey | Alır |
|---|---|
| `@gnldev/server` REST (`/run`, `/stream`, `/workflows/:name/run`) | **workKey** (+ workScope) |
| `@gnldev/chat-adapter` | **workKey** — bugünkü `${body.id}:${lastMsg.id}` türetimi workKey'e terfi eder |
| `@gnldev/agui` | **workKey** |
| | **SAPMA (ikisi için de): terfi KOŞULLU — İKİ REJİM var.** Türetme bir ADRES ister (§6) ve bu iki rota kendi auth'unu getirmiyor; öznesi olmayan bir kurulumda terfi ham runId'de kalır, çünkü `useChat` hızlı başlangıcını 400'e çevirmek düzeltme değil regresyondur. Özne varsa `run1_`, yoksa bugünkü ham id — baytı baytına. agui'de bir incelik daha: `body.workKey` (yeni alan, kimse kaybetmez) fail-closed 400 verir, `Idempotency-Key` (çoğu zaman bir proxy'nin damgası) ham kalır. Hangi rejimde olunduğu koruma matrisinin `identity` satırından okunur. |
| `@gnldev/client` SDK | **workKey** |
| `runDurable` / `resumeRun` / `forkRun` / `streamDurable` (motor API) | **ham runId** — resume/fork hash'i tersine çeviremez; ham yüzey zorunludur ve BELGELİDİR. `run1_` ve `#` bu yüzeyde rezerve: taklit throw. |
| Motor bileşikleri: `sched:`, `job:`, `a2a:`, `eval:`, `agent:`, `wf:`, `net:`, `batch:` | **istisna — okunabilir kalır.** Bunlar motorun kendi bastığı, zaten deterministik, hiç saklanmayan kimlikler. Özellikle `a2a:` hash'lenirse iki deployment arasında exactly-once kırılır. `run.ts`'in mevcut yorumu bu kararı zaten vermişti. |

Çocuk türetmesi: **`nestedAgentRunId` DOKUNULMAZ** (heyet şartı — uygulama gerçekçisi).
`(parentRunId, toolCallId)`'in saf fonksiyonu kalır; `limits.ts` (maliyet toplama) ve
`retention.ts` (purge kaskadı) çocuğu gözlemlemeden yeniden türetir — kök hash'lense de
`agent:run1_<hash>:<tcid>` doğal oluşur, derinlik başına ~50 karakter; 512 sınırı ~10 seviye taşır.

## 8. Sözleşme metinleri (hakem taslakları — kabul)

**workKey tanımı (kanonik, EN):**
> **A `workKey` is your name for a unit of work — not for a conversation.** While the run it
> opened still exists, another call arriving with the same `workKey` in the same `workScope` is
> routed to that run instead of starting a second one.
> **Coming from `thread_id`?** There the same key means *continue this conversation*. Here the
> same key means *this is the same job*: reuse a `workKey` to **retry** work, never to add a
> turn. A conversation is `threadId` — a different field, and you can use both at once.
> A `workKey` is a **business name** (the invoice being issued, the document being published,
> the firmware rollout for device 7742, tonight's reconciliation batch), not a random retry
> token. Keep sensitive data out of it — a `workKey` is echoed in error bodies and shown on
> Studio screens.

**TR:**
> **`workKey`, bir konuşmanın değil, bir İŞİN sizin verdiğiniz adıdır.** Açtığı koşu kaydı
> yaşadığı sürece, aynı `workScope` içinde aynı `workKey` ile gelen çağrı ikinci bir koşu
> başlatmaz; o koşuya yönlendirilir. `thread_id`'den geliyorsanız: orada aynı anahtar "devam et"
> demektir, burada "bu aynı iş" demektir — yeniden denemek için kullanın, tur eklemek için asla.
> Konuşma `threadId`'dir, ayrı alandır. `workKey` bir iş adıdır (kesilen fatura, yayımlanan
> belge, 7742'nin yazılım güncellemesi, bu gecenin mutabakatı); hassas veri koymayın — hata
> gövdelerinde yansır, Studio'da görünür.

**Benzersizlik ömrü (garanti dilsiz):**
> Bir `workKey` ne kadar benzersiz kalır: **koşu kaydı yaşadığı sürece — bir dakika fazlası
> değil.** Tanıma, metnin değil saklanan kaydın özelliğidir. Süpürme o koşuyu sildiği an anahtar
> yeniden yabancıdır. Ayarlanacak sayı "koşuları ne kadar tutayım" değil, bir karşılaştırmadır:
> **saklama pencereniz, istemcilerinizin üretebileceği en uzun yeniden denemeden kısa olmamalı.**
> Bunu garanti edemiyorsanız mezar taşlarını açın (`tombstones: true` + `tombstonePolicy:
> 'reject'`): geç deneme işi sessizce baştan başlatmak yerine `409 run_swept` ile reddedilir.
> Mezar taşı bir rettir, cevap değil.
> (Temporal'ın retention-uniqueness tuzağı bu paragrafın varlık sebebi: sonucu söylenmeyen
> pencere, kullanıcının forumda öğrendiği sürpriz olur.)

**Hata gövdesi kuralı (3 satır):**
1. `error` mesajı: sabit cümle + opak runId. workKey mesaja girmez (error string'i en gelişigüzel
   log'lanan alandır).
2. `detail`: workKey + workScope + runId yansıtılır (çağıran kendi anahtarını zaten bilir).
3. Log/telemetri/idem-ledger: yalnız opak runId ve workKey'in hash'i (conflictLedger'ın mevcut
   "codes, hashes, never content" kuralına katılır).
Zorunlu dürüstlük cümlesi: **"runId, workKey'inizin kararlı bir takma adıdır (pseudonym),
anonimleştirilmesi değildir"** — düşük entropili workKey sözlükle geri çözülür; GDPR'da kişisel
veri statüsü sürer.

**Header sözleşmesi:**
> `X-Gnl-Run-Id` her cevapta döner: çağrının düştüğü koşunun opak kimliği — log/iz/Studio
> eşleştirme tutamağı. **Yeniden deneme anahtarınız değildir; yeniden denemek için aynı
> `workKey`'i gönderin.** `X-Gnl-Idempotency-Status: new|replay` aynen kalır.
> `X-Gnl-Work-Key` yankısı VARSAYILAN KAPALI (`echoWorkKey: true` opt-in) — header'lar fiilen
> log yüzeyidir (proxy/CDN/HAR); serbest metin workKey oraya varsayılan gitmez.

**SAPMA (header sözleşmesi, son satır):** `echoWorkKey` **hiç uygulanmadı** — ne seçenek olarak ne
de header olarak. Yani `X-Gnl-Work-Key` yankısı "varsayılan kapalı" değil, **yok**; opt-in bir kapı
da yok. Kararın gerekçesi (header'lar log yüzeyidir) bu sonucu zaten destekliyor, o yüzden eksik
olan koruma değil seçenek: bir kurulum bugün o yankıyı isterse alamaz. `X-Gnl-Run-Id` ve
`X-Gnl-Idempotency-Status` aynen belirtildiği gibi duruyor. Ayrıca `X-Gnl-Run-Id`'nin kendisi de
yüzeye göre değişiyor — `@gnldev/server` ve `@gnldev/chat-adapter` header'da döndürüyor,
`@gnldev/agui` ise AG-UI olay zarfında taşıyor (bkz. §7 SAPMA satırı).

## 9. Doküman düzeltme listesi (hakem taraması)

| Yer | Sorun | Düzeltme |
|---|---|---|
| `docs/GUIDE.md:454` (+tr) | `// SAME runId = continue` — **tam da öldürmek istediğimiz yanlış öğreti, kendi kılavuzumuzda** | `workKey` + "SAME workKey = SAME work" |
| `packages/durable/README.md:37`, kök `README.md:33` | `runId: 'order-123' // idempotency key (orderId/sessionId)` — sessionId örneği thread karışıklığını davet ediyor | workKey + "never a sessionId" |
| `packages/server/README.md:111` | "runId is the idempotency key" | workKey diline çevir (yüzey tablosuna göre) |
| `packages/a2a/README.md:3` | runId'nin iki şekli olduğunu söylemiyor | "Engine-issued runs keep readable composite ids on purpose" cümlesi eklenir |
| `packages/chat-adapter/README.md:33-35` | "retry key is a header contract" — yeni dünyada yanlış | §8 header cümlesiyle değiştir |
| `packages/durable/README.md:331` | conflictLedger "PII-free" — workKey hash'i pseudonym'dir | "key hashes… not an anonymisation" düzeltmesi |
| strictInput maddesi | "Stripe's semantics" — statü farklı (Stripe 400, biz 409) | "kural Stripe'ın, statü bizim" parantezi |
| 10+ pakette çıplak "exactly-once" | Bu kararın yaratmadığı, ama beraber okunacak borç | **Ayrı kuyruk kalemi** — bu paketin kapsamı dışında |

> **Şerh (sonradan):** son satırdaki kuyruk kalemi kapandı — çıplak "exactly-once" geçişleri paket
> README'lerinde, kök README'lerde, `docs/GUIDE*` ve `docs/errors/`'ta ya `at-most-once`'a çevrildi ya
> da mekanizma adına (journal dedup / CAS ack marking / idempotent export) daraltıldı; kanonik şerh
> [`packages/durable/README.md`](../packages/durable/README.md#what-never-charged-twice-actually-means).
> Bu belgenin kendi metni tarih kaydı olarak olduğu gibi bırakıldı.

## 10. Hakem boşluklarının kararları

1. **Yüzey tablosu:** §7'de karara bağlandı.
2. **Org'suz kurulumda `workScope: 'org'`:** kurulum-geneli kapsam sayılır (`scopeValue =
   '~deployment'` sentineli — resourceId validasyonunun izin vermediği karakterden). Sessiz
   değildir: anlam JSDoc'ta tanımlı + açılış koruma matrisinde satır olarak görünür. Throw
   edilmez çünkü org opsiyonel altyapıdır ve tek-kiracılı kurulum (prod-test dahil) meşru ana
   akımdır.
3. **Tombstone ↔ GDPR gerilimi:** mezar taşı yalnız **hash** saklar. `run_swept` cevabındaki
   workKey depodan değil **isteğin kendisinden** yansıtılır — çağıran kendi anahtarını zaten
   biliyor; silme silinmiş kalır, hata yine konuşur.

## 11. Reddedilen alternatifler (gerekçeleriyle, yeniden açılmasın diye)

| Alternatif | Neden red |
|---|---|
| Bugünkü düzen + bekçiler | Bekçi sayısı büyüyen eğri: bir turda 1 kritik + 3 kırık, hepsi aynı kökten |
| Okunur namespace (`run.u-ali.talep-42`) | PII anahtarın kendisine girer — loglardan/indekslerden geri çağrılamaz; iç içe derinlikte 512'ye çarpar |
| Mint + lookup | Her istekte fazladan okuma + eşleme tablosu ayrı tutarlılık yüzeyi (FDB directory layer'ın belgeli dertleri) |
| HMAC | Sır rotasyonu = tüm yarım işlerin resume ölümü; durable determinizm sırra bağlanamaz. Org izolasyonu zaten `withOrg` önekinde |
| Saf opak id (workKey'siz) | Adres-seviyesi idempotency ölür |
| Id'ye zaman/sıra gömme | Determinizmi, dolayısıyla dedup'u öldürür (ULID/UUIDv7 ile çelişki bilinçli) |
| Temporal koşum zinciri (ayrı runId nesli) | GNL'de run=tur; replay + `#<n>` ekseni ihtiyacı karşılar; zincir makinesi fazlalık |

**Dürüst sınırlar (vaat metnine girer):**
- *Çakışma yapısal ölür; gizlilik kapısaldır.* sha256 offline hesaplanabilir — "tahmin edip okuma"
  saldırısını hash değil sahiplik kapıları durdurur (OWASP-hizalı duruş: tahmin edilemezlik
  defense-in-depth'tir, birincil savunma değil).
- *Yazma yerelliği:* rastgele dağılımlı anahtar tek-node btree'de UUIDv4-sınıfı yazma maliyeti
  taşır (~%29 insert). Mevcut chat id'leri zaten UUID-rastgele olduğundan fark nötr; ama zaman-
  sıralı ailelerden (`sched:` vb.) hash'e geçilmemesinin bir sebebi de bu. Kabul edilir, gizlenmez.
- *Deterministik ad geri alınamaz:* hash var oldukça kimlik "diriltilebilir" (Cloudflare
  idFromName dersi) — mezar taşı bu yüzden eşlemeyi de kapsar.
- *Slot kapma (squatting) ayırt edilemez:* dört girdiyi doğru bilen bir çağrı, şekil olarak geçerli
  bir taklittir ve motor onu meşru çağrıdan ayıramaz — koruma hash'te değil, sahiplik kapılarındadır
  (§6); ve doğmuş bir slotu rollover yeniden doğurmaz, atlar.

## 12. Uygulama planı (6 paket — uygulama gerçekçisinin planı + avukat şartı 4)

| # | Paket | İçerik | Risk |
|---|---|---|---|
| 1 | Hash + kimlik primitifi | `workDigest`/`derivedRunId` (tuple + DST), `run1_`/`#` rezervi, çarpışma vektör testleri | Düşük |
| 2 | Kayıt + görünürlük | `persistInput`/`claimIdentityInput` workKey+scope; `listRunsPaged` filtresi; tombstone eşleme kapsamı | Düşük |
| 3 | **Registry kapısı** | `RunOptions.runId` → opsiyonel; `workKey`/`workScope`/`onConflict`/`onReuse`; 4 basım noktası; çekirdek resourceId doğrulaması; strictInput zorunluluğu | **EN YÜKSEK** |
| 4 | Önek-ayrıştırma temizliği | `batch.ts:164`, studio `startsWith('batch:')`, studio-ui `deriveWorkflowName`/`parseOrgFromRunId`; rollover/replay → `#` ekseni | Orta |
| 5 | HTTP + CLI yüzeyleri | server/chat/agui/client uçları, openapi, CLI (workKey kabulü + çözücü), header sözleşmesi | Orta |
| 6 | Studio UI + vaat metni | workKey sütunları, §8 metinleri, §9 doküman düzeltmeleri, `check-doc-samples` yeşil | Düşük |

Ek kapsam (avukat şartı 4): `run1_`/`#` rezervasyonunun ham yüzey testleri + sekiz anahtar
ailesinin (`xrun: xthr: sem- semtomb- agent: wf: @N :replay:`) yatay işlem denetimi (sweep'in
aile kaçırma geçmişi var — `xrun:` emsali).

Tahmin: ~700-900 üretim satırı + ~1.200-1.800 test satırı. prod-test göçü: **big-bang**
(DROP + 3 satır + e2e 14/14 yeniden — dual-read'in okuyacağı eşleme yok, kurmak israf).
Motor testlerine (134 dosya, `runDurable` literal runId) dokunulmaz — ham motor sınırının
en değerli mühendislik sonucu.

## 13. Bloke edici şartların özeti (uygulama öncesi kapanacak — hepsi bu belgede çözümlü)

1. Tuple kodlaması + DST hash'in içinde (§3) ✔ tasarımda
2. Ajan adı hash'te zorunlu (§3, §6) ✔ tasarımda
3. `resource` scope'ta resourceId hash'te + çekirdek doğrulamada (§6) ✔ tasarımda
4. `run1_` uzayında strictInput zorunlu + workKey-farkında ret metni (§5) ✔ tasarımda
5. Yürütme ekseni `#<n>`; rollover/replay taşınır (§4) ✔ tasarımda
6. `nestedAgentRunId` dokunulmaz (§7) ✔ tasarımda
7. Yüzey tablosu (§7) + org'suz 'org' (§10.2) + tombstone hash-only (§10.3) ✔ kararlaştırıldı

## 14. Kaynak seçkisi

NIST SP 800-185 (TupleHash) · RFC 9380 (domain separation) · CVE-2026-76581, CVE-2026-71326
(naif concat) · Temporal WorkflowId/RunId + ReusePolicy/ConflictPolicy + documentation#2280 +
retention-uniqueness forum · Stripe idempotent requests · IETF draft-ietf-httpapi-idempotency-key ·
Cloudflare Durable Objects idFromName + ctx.id.name changelog · Kafka KIP-98 (epoch fencing) ·
git hash-function-transition (LWN) · Kubernetes #43449 (FNV-32 çakışması) · ACM "On the Reruns
of GitHub Actions Workflows" (%3,2) · bir graf-framework'ünün durable-execution dokümanı (idempotency itirafı) ·
OWASP IDOR Cheat Sheet · PostgreSQL UUIDv4/v7 btree ölçümleri.
