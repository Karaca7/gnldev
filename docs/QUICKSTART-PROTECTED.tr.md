# Beş dakikada korumalı bir GNL

"Çalışan bir GNL" değil. Çalıştırmak tek komut ve hiçbir şey kanıtlamaz. Bu sayfanın sonunda
**bir tekrarın reddedildiğini görmüş** olacaksınız; ayrıca hangi korumaların açık, hangilerinin
kapalı olduğunu ve kapalı olanların neye mal olduğunu bileceksiniz.

---

## 1. Tek komut

```bash
npx @gnldev/cli init my-agent --yes && cd my-agent && pnpm install
```

`--yes` önerilen cevapları alır. Onu atarsanız bir kapı sorusu ve en fazla dört soru daha gelir —
[hangileri ve neden sadece dört](#ek-dört-soru).

API anahtarı yok. Starter sahte bir model taşır, aşağıdaki her şey sizin makinenizde olur.

## 2. Ne aldığınızı okuyun

`init`'in bastığı son şey bir matris ve on saniyeye değer:

```text
what is protecting it   ✓ on · ○ off · ─ dev-only · ? per-call
  ✓ journal          SqliteStorage                         explicit
  ✓ dedup profile    assistant                             explicit
      a human is on screen: money/notification repeats ask, idempotent writes stay silent
  ○ identity         not bound — runs are born ownerless   explicit
  ? work identity    per call: a workKey names it, or a raw runId is it
  ○ thread gate      no memory — threadId carries nothing  default
  ○ retention        not wired                             default
```

(Kısaltılmış. `gnl doctor` tamamını, istediğiniz an, config gerçekte yüklendiği hâliyle basar.)

`?` satırı bir boşluk değil: bir çağrının işini adlandırması (`workKey` — koşu id'sini motor ondan
türetir) mi yoksa ham bir `runId` vermesi mi, istek başına kararlaştırılır; hiçbir config bunu
cevaplayamaz. Yanında taşınacak tek cümle şu: **bir `workKey`, yalnızca açtığı koşu kaydı yaşadığı
sürece tanınır** — iki satır aşağıdaki `○ retention` bu yüzden bir ev işi ayarı değildir.

Satırlar config'inizden **hesaplanır**, ezberden okunmaz. Bu ayrım ekranın var oluş sebebi: bu CLI'ın
eski bir sürümü, bir auth sağlayıcı var diye "(auth: protected)" basıyordu — o sağlayıcının tek
kimlik bilgisi npm paketinde yayımlanmış bir token olduğunda bile. Anlattığı şeyin yanında elle
tutulan bir koruma listesi, en son ne dediyse onu söyler.

## 3. Aynı şeyi iki kez isteyin

Beş dakikaya değen kısım burası.

```bash
gnl dev
```

<http://localhost:3000/studio> adresini açın, `assistant` ajanını seçin ve bir mesaj gönderin. Sonra
**tam olarak aynı mesajı** tekrar gönderin.

`preset: 'assistant'` ile tekrarlanan bir yan etki sessizce iki kez olmaz, sessizce yutulmaz da —
**bir soruya dönüşür**. İkinci deneme askıya alınır ve birinin "evet, gerçekten istedim" demesini
bekler.

Sonra neyin kaydedildiğine bakın:

```bash
gnl run <runId>      # zaman çizelgesi: tool çağrısı ve tekrar hakkında verilen karar
gnl doctor           # "time to first protected run" — artık "never" değil, gerçek bir sayı
```

O sayı, bunların gerçekten bağlı olup olmadığının tek dürüst ölçüsü. Hiçbir şeyi reddetmemiş bir
profil, yalnız config'e bakıldığında hiçbir şeye bağlı olmayan bir profille aynı görünür.

## 4. Üç ○ satırı, her biri tek komut

Kapalı olan her satır bir sebeple kapalı ve her birinin yapılacak tek şeyi var.

**`○ thread gate` — konuşmalar hatırlamıyor.**

```bash
gnl add memory
```

`src/memory.ts` yazar; `gnl.config.ts` içindeki `memoryFactory` satırının yorumunu kaldırın. Bu
olmadan `threadId` bir sınır değil, bir etiket — motor, koyacak yeri olmayan bir threadId aldığında
süreç başına bir kez uyarır.

**`○ retention` — hiçbir şey silinmiyor.**

```bash
gnl sweep --older-than 30d        # varsayılan kuru çalışma; gerçekten silmek için --yes
```

Hiçbir şey kendiliğinden süpürmez, bilerek. Bir koşum, kendisine verilen prompt'u bir insan ya da bir
cron girdisi bunu çalıştırana kadar süresiz tutar. Bunu bir zamanlayıcıya koyun; pencere,
istemcilerinizin **yeniden deneme ufkundan uzun** olmalı — yoksa geç gelen bir deneme süpürülmüş bir
koşuma çarpar ([`run_swept`](./errors/run_swept.md)).

**`○ identity` — koşumlar sahipsiz doğuyor.**

```bash
gnl init my-agent --identity end-users     # yeni proje için: src/identity.ts yazar
```

Sonradan değiştirmesi gerçekten pahalı olan tek satır bu: sahipsiz doğmuş koşumlarla dolu bir
journal'a sahiplik sonradan eklenemez, çünkü kimin için olduklarını hiçbir şey kaydetmemiştir.
Var olan bir proje için `src/identity.ts`'i kendiniz yazın — çözümleyici on beş satır kadar ve tek
yanlış cevap yüksek sesle söylenmeyi hak ediyor:

```
// ASLA: const resourceId = (await req.json()).resourceId;
```

İstek gövdesinden okunan bir özne, çağıranın canı kimi isterse onu söylemesidir. Sunucunun kurduğu
bir şeyden okuyun: doğrulanmış bir oturum, imzası kontrol edilmiş bir JWT, `principalOf(req)?.id`.

## 5. Dağıtmadan önce: `─` satırı

`gnl dev`'i tekrar çalıştırın ve matriste bir `─` arayın:

```text
  ─ thread gate      memory derived from storage           default
      memory is on HERE (gnl dev) and off in src/app.ts — `gnl add memory`
```

`─` şu demek: **bunu bu süreç açtı, dağıtımınızda olmayacak.** `gnl dev`, Playground'un thread'i olsun
diye `storage`'dan bir bellek türetir; asıl dağıttığınız dosya olan `src/app.ts` türetmez. Aynı
config, iki davranış: konuşmalar sizin makinenizde hatırlar, üretimde sessizce unutur.

Her `─` bu şekildedir. Bu ekranda asla göndermemeniz gereken tek işaret odur.

---

## Ek: dört soru

`gnl init` tam olarak dört şeyi sorar, çünkü bunlar bir projenin kendi kodunu okuyarak keşfedemeyeceği
ve sonradan ucuza değiştiremeyeceği kararlardır:

| Soru | Bayrak | Neden varsayılan bırakılmıyor |
| --- | --- | --- |
| Aynı iş ikinci kez gelirse ne olsun? | `--preset assistant\|headless\|critical` | Bir tool'un `effectClass`'ı **yalnızca** bir profil üzerinden okunur. Yanlış seçerseniz projedeki her bildirim sessizce etkisiz kalır. |
| Her koşum kime ait? | `--identity internal\|end-users` | Sahiplik, sahipsiz doğmuş koşumlara sonradan eklenemez. |
| Her koşumun kaydı nerede tutulsun? | `--store sqlite\|pg` | İlk gün tek satır fark, doksanıncı gün bir göç. |
| İnsanlar buraya nasıl ulaşacak? | `--serving dev\|own\|mount` | `gnl dev` siz geliştirirken her şeyi servis eder, yani "şimdilik hayır" gerçek bir cevaptır — worker/cron projesinin kalıcı cevabı da budur. Diğer ikisi dosya yazar ve yazdıkları farklıdır: `own` `src/server.ts` alır, `mount` zaten sahip olduğunuz sunucuya yapıştıracağınız satırları alır (`--host` çerçeveyi adlandırır). |

Verdiğiniz her bayrak kendi sorusunu **cevaplar**, o soru sorulmaz. `--yes` ya da hiç terminal
olmaması (CI, bir ajan) varsayılanları alır ve asla beklemez.

Özellikler bilerek soru **değil**: `gnl add <feature>` onları ihtiyaç duyduğunuz gün ekler, atlamış
bir proje hiçbir şey kaybetmez. Sunucu girişi bir süre bu kategorideydi ve çıktı — dördüncü satıra
bakın: DOSYALAR sonradan eklenebilir, ama "zaten bir sunucum var" ile "sunucusu olmayan bir worker'ım"
kimsenin söyleyemediği cevaplardı, komut onlar adına tahmin ediyordu.

---

## Buradan sonra

- **[Rehber](./GUIDE.tr.md)** — her katman, sırayla, her birinin var olduğu arıza ile.
- **[Hata kodları](./errors/README.md)** — teldeki her kod için bir sayfa: ne oldu, neden, ne yapmalı.
- **[`@gnldev/durable`](../packages/durable/README.md)** — dedup merdiveninin kendisi: hash, claim, confirm, critical, semantic.
