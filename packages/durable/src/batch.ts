// BATCH — planla → tek onay → koş → raporla (heyet tasarımı + hakem kararı wf_b92e393e).
//
// KAPSAM ŞERHİ (denetçi): SEMANTİK katman batch'te BİLİNÇLİ kapalıdır — batch deterministik iş
// listesidir, kimlik XID'le tam yakalanır; embedder taşımanın maliyeti karşılıksız. semanticIdentity
// beyanı yine de değerlidir: XID/preflight onu kullanır.
// KOŞUM MEKANİĞİ (Hakem Karar 1): SAF MİNİ-RUNNER — model yok, iş listesi deterministik; her item
// için tam DurableCtx kurulur ve durableTool wrapper'ı DOĞRUDAN çağrılır. Böylece exactly-once,
// confirm, dup-merdiveni, XID, semantik, override izi — TÜM choke-point'ler bedavaya gelir (Studio
// approve-runner'ının kullandığı desenin aynısı). runId = batch:<batchId>:<itemKey>,
// toolCallId = item:<itemKey> (deterministik → onay anahtarları öngörülebilir).
//
// SUSPEND-ITEM RESUME (Karar 2): askıya düşen item'ın onayı run() tekrar çağrısıyla döner
// (`approvals: { 'item:<key>': true }`); kararlar run.ts'in TEK resolveApprovals'ıyla journal'a
// claim'lenir — Studio'dan verilen karar parametresiz run()'da da görünür. Batch-doğumlu runId
// resumeRun'la RESUME EDİLMEZ (frozen :input yok — 3bb1d0da entry-point dersinin batch hali).
//
// PLAN/TOKEN (Karar 3): preflight SAF OKUMADIR (yazım yok, istediğin kadar çağır);
// token = argsHash(kanonik items + policy). run() başında plan first-wins claim'lenir; claim
// KAYBI ≠ 409 — kayıptan sonra token karşılaştırılır: eşitse meşru rapor-replay'i, farklıysa
// BatchPlanMismatchError (409 batch_plan_mismatch, CALLER_CONFLICT_CODES'ta). Rapor her koşumda
// item dönüşlerinden TÜRETİLİR (asla bayatlamaz); batch:<id>:report yalnız ucuz okuma yüzeyi.
//
// SINIFLANDIRMA (hakem tuzak 1): terminal STATÜYE değil ÇIKTI ŞEKLİNE bakılır — skip'in terminali
// bilinçli olarak 'denied'dir (K12); __gnl_skipped / __denied / __gnl_suspend / __gnl_limit_exceeded /
// __gnl_blocked zarfları ayrıştırır.
//
// KIRMIZI ÇİZGİLER: model karar anında bilmez (model yok); skor karar vermez (XID deterministik);
// sessiz-VE-görünmez yok (her item raporda + incident/zarf izleri); onDuplicate kararı OKUYAN
// politikadan gelir (kayıtlar veri taşır).
import { argsHash } from './hash.js';
import { runKeys, claim, claimIdentityInput } from './journal.js';
import type { Journal, DurableCtx } from './journal.js';
import { durableTool } from './durable-tool.js';
import { resolveApprovals, hasRunProbe } from './run.js';
import { readXid, xidPlanOf, xidWhen, amountsDifferOf } from './xid.js';
import { identityUnusableReason } from './semantic-dup.js';
import { BatchPlanMismatchError } from './errors.js';
import type { AnyTool } from './types.js';

export interface BatchConfig {
  /** Koşulacak araç — TÜM durable beyanlarıyla (sideEffect/recover/confirm/semanticIdentity/effectClass). */
  tool: AnyTool;
  toolName: string;
  /** Geliştiricinin TEK kritik ödevi: item'ı İŞ dünyasında tekil kılan anahtar (sipariş no, fatura
   *  ref — satır numarası DEĞİL). Kötü anahtar = o batch için korumanın çökmesi (belgeli). */
  itemKey: (item: unknown) => string;
  /** Kimlik sahibi (XID kapsamı) — verilmezse kanallar-arası görünürlük kapalıdır ve plan bunu söyler. */
  resourceId?: string;
  /** Tekrar politikası (heyet): transactional default'u 'suspend-item'. 'fail-batch' ilk tekrar
   *  tespitinde kalan item'ları KESER (koşulmazlar, raporda not-run). */
  onDuplicate?: 'skip' | 'suspend-item' | 'fail-batch';
}

export interface BatchPlanRow { itemKey: string; detail: string }
export interface BatchPlan {
  batchId: string;
  token: string;
  fresh: number;
  /** Bu batch soyunda ZATEN tamamlanmış item'lar (aynı batchId'nin önceki koşumu). */
  exactRepeats: BatchPlanRow[];
  /** Askıda onay bekleyenler — hatırlatma zorunluluğunun preflight ayağı. */
  suspended: BatchPlanRow[];
  /** BAŞKA kanaldan tamamlanmış aynı iş kimlikleri (origin'li: "5 dk önce, sohbetten"). */
  xidHits: BatchPlanRow[];
  /** Aynı kimlik, farklı tutar — onaydan önce dikkat çağrısı. */
  amountMismatches: BatchPlanRow[];
  /** resourceId verilmedi → kanallar-arası sütunlar "kapsam dışı" (boş liste 'temiz' OKUNMASIN). */
  xidScopeDisabled?: boolean;
  /**
   * Beyan BU item'ı tanımlayamadı (nesne değerli anahtar, ya da argümanlarda hiç bulunmayan anahtar)
   * → kanallar-arası kontrol o item için YAPILMADI.
   *
   * `xidScopeDisabled` ile aynı gerekçe, bir seviye aşağıda: orada tüm plan kapsam dışıdır, burada
   * tek tek item'lar. İkisi de aynı yanlış okumayı kapatır — `xidHits: []` "temiz" değil, "bakılmadı"
   * olabilir. Guard'ın kendisi doğru ve sessiz olması güvenli tarafta; ama operatörün `fresh: 3`
   * görüp korumanın o koşumda hiç devrede olmadığını öğrenememesi, bu dosyanın `durable-tool.ts`'te
   * yazdığı "OFF and said so beats wrong and silent" ilkesinin tam tersi olurdu.
   */
  xidIdentityUnusable?: BatchPlanRow[];
  /** Batch-içi kirli veri: aynı argümanlar birden çok itemKey'de. */
  intraBatchDuplicates: BatchPlanRow[];
}

export type BatchItemOutcome = 'done' | 'replayed' | 'skipped' | 'denied' | 'suspended' | 'failed' | 'not-run';
export interface BatchReport {
  batchId: string;
  token: string;
  summary: Record<BatchItemOutcome, number>;
  items: Array<{ itemKey: string; runId: string; outcome: BatchItemOutcome; detail?: string }>;
}

const SAFE_ID = /^[A-Za-z0-9_-]+$/;
function assertSafeId(kind: string, v: string): void {
  if (!SAFE_ID.test(v)) throw new Error(`@gnldev/durable: batch ${kind} '${v.slice(0, 40)}' must match ${SAFE_ID} — it becomes part of journal keys and runIds.`);
}

const itemRunId = (batchId: string, key: string) => `batch:${batchId}:${key}`;
const itemToolCallId = (key: string) => `item:${key}`;
const planKey = (batchId: string) => `batch:${batchId}:plan`;
const reportKey = (batchId: string) => `batch:${batchId}:report`;

/** Kanonik parmak izi: itemKey'e göre SIRALI (liste sırası plan kimliğini değiştirmez). */
function tokenOf(cfg: BatchConfig, items: unknown[]): { token: string; keyed: Array<{ key: string; item: unknown }> } {
  const keyed = items.map((item) => ({ key: cfg.itemKey(item), item }));
  for (const { key } of keyed) assertSafeId('itemKey', key);
  const dupKeys = keyed.map((k) => k.key).filter((k, i, a) => a.indexOf(k) !== i);
  if (dupKeys.length) throw new Error(`@gnldev/durable: duplicate itemKey(s) in batch: ${[...new Set(dupKeys)].join(', ')} — an itemKey must be unique within the batch.`);
  keyed.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const token = argsHash({ policy: cfg.onDuplicate ?? 'suspend-item', items: keyed.map((k) => ({ key: k.key, item: k.item })) });
  return { token, keyed };
}

function mapPolicy(p: BatchConfig['onDuplicate']): 'skip' | 'suspend' | 'block' {
  return p === 'skip' ? 'skip' : p === 'fail-batch' ? 'block' : 'suspend';
}

/** Çıktı ŞEKLİNDEN sınıflandırma (hakem tuzak 1 — statüye bakma). */
function classify(out: unknown, replayed: boolean): { outcome: BatchItemOutcome; detail?: string; cut?: boolean } {
  const o = out as Record<string, unknown> | null | undefined;
  if (o && typeof o === 'object') {
    if ('__gnl_suspend' in o) return { outcome: 'suspended', detail: (o.__gnl_suspend as { reason?: string })?.reason };
    if ('__gnl_skipped' in o) return { outcome: 'skipped', detail: (o as { notice?: string }).notice };
    if ('__denied' in o) return { outcome: 'denied', detail: (o as { reason?: string }).reason };
    if ('__gnl_limit_exceeded' in o) {
      const lim = o.__gnl_limit_exceeded as { message?: string; kind?: string };
      // KESME yalnız TEKRAR tespitinde (hüküm 7) — taint/maliyet blokları item'ı düşürür, batch'i değil.
      return { outcome: 'failed', detail: lim?.message, cut: lim?.kind === 'duplicateSideEffect' };
    }
    if ('__gnl_blocked' in o) return { outcome: 'failed', detail: 'busy (another worker holds this item)' }; // tek meşgul item batch'i düşürmez
  }
  return { outcome: replayed ? 'replayed' : 'done' };
}

export function createBatch(journal: Journal, cfg: BatchConfig) {
  if (typeof cfg.itemKey !== 'function') {
    throw new Error("@gnldev/durable: batch requires `itemKey` — it is the developer's one critical duty (what makes an item unique in the BUSINESS, not the row number). Refused loudly rather than silently keyless.");
  }
  // K26: suspend-item'ın onay-dönüşü journal kararlarının OKUNMASINA dayanır (resolveApprovals'ın
  // listKeys zenginleştirmesi) — listKeys'siz adapter'da karar yazılır ama sonraki run() göremez:
  // "kaydettim, sonra koşarım" vaadi sessizce yalan olur. Loud red, sessiz-inert değil.
  if ((cfg.onDuplicate ?? 'suspend-item') === 'suspend-item' && typeof journal.listKeys !== 'function') {
    throw new Error("@gnldev/durable: batch onDuplicate 'suspend-item' needs journal.listKeys — recorded approvals are read back through it; without listKeys the decision would be written and never seen. Use 'skip'/'fail-batch' or a listKeys-capable journal.");
  }
  // H10b'nin batch hali: araç yan-etki niyetini beyan etmemişse burada, koşum başlamadan reddedilir
  // (durableTools'un strict kapısı batch yolunda çalışmaz — mini-runner tek aracı sarar).
  const t = cfg.tool as { sideEffect?: boolean; idempotent?: boolean; recover?: unknown };
  if (t.sideEffect === undefined && t.idempotent === undefined && typeof t.recover !== 'function') {
    throw new Error(`@gnldev/durable: batch tool '${cfg.toolName}' does not declare its side-effect intent — add sideEffect/idempotent/recover (the library's own 'developer forgot to mark it' standard).`);
  }

  async function preflight(batchId: string, items: unknown[]): Promise<BatchPlan> {
    assertSafeId('batchId', batchId);
    const { token, keyed } = tokenOf(cfg, items);
    const plan: BatchPlan = {
      batchId, token, fresh: 0, exactRepeats: [], suspended: [], xidHits: [], amountMismatches: [],
      intraBatchDuplicates: [], ...(cfg.resourceId ? {} : { xidScopeDisabled: true }),
    };
    // batch-içi argsHash çakışması: sıfır okuma, bellek-içi
    const byHash = new Map<string, string>();
    for (const { key, item } of keyed) {
      const h = argsHash(item);
      const prev = byHash.get(h);
      if (prev) plan.intraBatchDuplicates.push({ itemKey: key, detail: `same arguments as item '${prev}'` });
      else byHash.set(h, key);
    }
    for (const { key, item } of keyed) {
      // okuma 1: kendi soyundaki terminal kayıt
      const rec = await journal.get<{ status?: string; output?: unknown }>(runKeys.tool(itemRunId(batchId, key), itemToolCallId(key)));
      if (rec?.status === 'succeeded') { plan.exactRepeats.push({ itemKey: key, detail: 'already completed in a previous run of this batch' }); continue; }
      if (rec?.status === 'suspended') { plan.suspended.push({ itemKey: key, detail: 'awaiting a human decision (reminder due)' }); continue; }
      // okuma 2: kanallar-arası kimlik (yalnız beyan + resourceId varsa)
      // The fourth XID call site, and the one a guard added in durable-tool.ts would NOT cover: the
      // preflight reads the same key family with the same declaration, so a declaration that cannot
      // identify the item (an object-valued key, or a key absent from the args) would report every
      // item as "already completed in another channel". Same check, same direction — the item is
      // simply not cross-checked, which is the behavior without the declaration at all.
      const idUnusable = cfg.resourceId && cfg.tool.semanticIdentity
        ? identityUnusableReason(cfg.tool.semanticIdentity, item)
        : undefined;
      // Atlandığını SÖYLEYEREK atla. Boş bırakmak, "bu item kanallar-arası temiz" ile "bu item'a
      // hiç bakılmadı"yı aynı çıktıya indirirdi.
      if (idUnusable) (plan.xidIdentityUnusable ??= []).push({ itemKey: key, detail: idUnusable });
      if (cfg.resourceId && cfg.tool.semanticIdentity && !idUnusable) {
        const x = await readXid(journal, xidPlanOf(cfg.tool.semanticIdentity, cfg.toolName, item, cfg.resourceId, `batch:${batchId}`));
        // self-filter BATCH-SCOPED (hakem tuzak 3): aynı batch'in BAŞKA item'ının yazdığı XID
        // "başka kanal" diye çift raporlanmasın.
        //
        // PAKET #4 — BU METİN-AYRIŞTIRMASI BİLEREK DURUYOR. runId'yi string olarak yoklayan yerleri
        // temizlerken buraya da bakıldı; kırık değil, çünkü `batch:<id>:<item>` motorun KENDİ bastığı
        // bileşik kimliktir (karar §7'nin istisna satırı) ve türetilmiş uzaya hiç girmez. Önek yalnız
        // bu ailenin id'lerine uyar: `run1_<hex>` ile başlayan bir XID `batch:` ile başlayamaz, yani
        // türetilmiş bir koşumun yazdığı kayıt bu süzgeci YANLIŞ tetikleyemez — ki tetikleseydi
        // sessizce yutulurdu, "başka kanalda zaten yapılmış" uyarısı hiç görünmezdi. Ölçüldü ve
        // execution-axis.test.ts'te çiviyle tutuluyor.
        if (x && !x.first.runId.startsWith(`batch:${batchId}:`)) {
          let now = Date.now(); try { if (journal.now) now = await journal.now(); } catch { /* görüntü saati — fail-open */ }
          const diff = amountsDifferOf(x, item);
          if (diff.length) plan.amountMismatches.push({ itemKey: key, detail: `same identity completed ${xidWhen(x, now)}, but ${diff.join(', ')} differ` });
          else plan.xidHits.push({ itemKey: key, detail: `same identity completed ${xidWhen(x, now)} (first: ${x.first.toolCallId})` });
          continue;
        }
      }
      plan.fresh += 1;
    }
    return plan;
  }

  async function run(batchId: string, items: unknown[], opts: { planToken: string; approvals?: Record<string, boolean> }): Promise<BatchReport> {
    assertSafeId('batchId', batchId);
    const { token, keyed } = tokenOf(cfg, items);
    if (opts.planToken !== token) {
      throw new BatchPlanMismatchError(
        `@gnldev/durable: batch '${batchId}' — the given planToken does not match these items/policy (plan ${opts.planToken} != actual ${token}). Approve a fresh preflight of the CURRENT list.`,
        { batchId, expectedToken: opts.planToken, actualToken: token },
      );
    }
    // Plan first-wins; claim KAYBI ≠ 409 (hakem tuzak 2): token eşitse bu, raporun meşru replay'idir.
    const won = await claim(journal, planKey(batchId), { v: 1, token, at: Date.now(), itemKeys: keyed.map((k) => k.key) });
    if (!won) {
      const frozen = await journal.get<{ token?: string }>(planKey(batchId));
      if (frozen?.token !== undefined && frozen.token !== token) {
        throw new BatchPlanMismatchError(
          `@gnldev/durable: batch '${batchId}' was already started with a DIFFERENT plan (${frozen.token} != ${token}) — one batchId carries one plan; use a fresh batchId for a changed list.`,
          { batchId, expectedToken: frozen.token, actualToken: token },
        );
      }
    }
    const report: BatchReport = {
      batchId, token,
      summary: { done: 0, replayed: 0, skipped: 0, denied: 0, suspended: 0, failed: 0, 'not-run': 0 },
      items: [],
    };
    let cut = false;
    for (const { key, item } of keyed) {
      const runId = itemRunId(batchId, key);
      if (cut) { report.summary['not-run'] += 1; report.items.push({ itemKey: key, runId, outcome: 'not-run', detail: 'fail-batch cut the remainder' }); continue; }
      const tcid = itemToolCallId(key);
      // Kararlar journal'a claim'lenir (run.ts'in TEK resolveApprovals'ı — kopya yasak: spent-slot
      // CAS inceliği oradadır) → Studio'dan verilen karar parametresiz run()'da da görünür.
      // `hasRun` BAĞLI: onsuz "iş yapıldı mı" sorusu belirsiz kalıyor ve resolveApprovals belirsizliği
      // güvenli yöne (yapıldı) yatırıyor — yani askıdaki bir item'a verilen İKİNCİ cevap (onayla →
      // sonra vazgeç) sessizce yok sayılıyordu, hem de iş henüz yapılmamışken. Sonda item'ın KENDİ
      // runId'siyle kuruluyor: item'ın araç kayıtları `batch:<id>:<key>` altında yaşıyor
      // (runKeys.tool(runId, tcid)), yani ajan yolundaki sondayla aynı anahtarı okuyor ve aynı
      // kesinlikte cevap veriyor.
      // `actor` GEÇİLMİYOR: batch'in kimlik alanı `cfg.resourceId` — "kimin işi", "kim cevapladı"
      // değil. İnsan cevabı buraya Studio'dan geliyor ve imzasını orada atıyor; burada uydurulan bir
      // isim, denetim izine yanlış tanık yazmak olurdu.
      const resolved = await resolveApprovals(
        journal, runId,
        opts.approvals?.[tcid] !== undefined ? { [tcid]: opts.approvals[tcid]! } : undefined,
        { hasRun: hasRunProbe(journal, runId) },
      );
      // SAHİP KAYDI — bellekteki ctx yetmiyordu. `cfg.resourceId` yalnız burada, süreç içinde
      // yaşıyordu; journal onu HİÇ öğrenmiyordu çünkü item koşumları `run()`'dan geçmiyor
      // (doğrudan `durableTool`) ve dolayısıyla `persistInput` hiç çağrılmıyor.
      //
      // Görünür bedeli kişi silmede: `listRunsPaged({resourceId})` sahibi `:input`'tan okuyor, yani
      // batch item koşumları bir kişinin koşum listesinde HİÇ görünmüyordu — silme talebinin keşif
      // listesi baştan eksikti ve eksikliği sessizdi. Sahiplik kapıları da aynı sebeple atıl kalıyordu.
      //
      // İlk yazan kazanır ve best-effort: bir kimlik kaydı item'ın koşmasını engelleyemez.
      if (cfg.resourceId) {
        await claimIdentityInput(journal, runId, {
          at: Date.now(), resourceId: cfg.resourceId, batch: batchId, itemKey: key,
        });
      }
      const ctx: DurableCtx = {
        journal, runId, approvals: resolved,
        ...(cfg.resourceId ? { resourceId: cfg.resourceId } : {}),
        channel: `batch:${batchId}`,
        replayLog: [], blockedAsSentinel: true,
        // scope 'run' BİLİNÇLİ: batch bir konuşma değildir (threadId yok) — thread istemek her
        // item'da loud-warn üretirdi; kanallar-arası bakışı zaten XID sağlıyor (kapı okuyor).
        limits: { sideEffectDuplicates: { action: mapPolicy(cfg.onDuplicate), scope: 'run' } },
      };
      try {
        const wrapped = durableTool(cfg.tool, ctx, cfg.toolName);
        const out = await (wrapped.execute as (args: unknown, o: { toolCallId: string }) => Promise<unknown>)(item, { toolCallId: tcid });
        const replayed = (ctx.replayLog ?? []).some((e) => e.toolCallId === tcid);
        const c = classify(out, replayed);
        report.summary[c.outcome] += 1;
        report.items.push({ itemKey: key, runId, outcome: c.outcome, ...(c.detail ? { detail: c.detail } : {}) });
        if (c.cut && (cfg.onDuplicate ?? 'suspend-item') === 'fail-batch') cut = true;
      } catch (e) {
        report.summary.failed += 1;
        report.items.push({ itemKey: key, runId, outcome: 'failed', detail: (e as Error).message?.slice(0, 300) });
      }
    }
    // Ucuz okuma yüzeyi — düz put (rapor her koşumda yeniden türetilir, bu kopya bayatlayabilir ve
    // bayatlaması zararsızdır; kaynak her zaman run() dönüşüdür).
    try { await journal.put(reportKey(batchId), report); } catch { /* best-effort */ }
    return report;
  }

  return { preflight, run };
}
