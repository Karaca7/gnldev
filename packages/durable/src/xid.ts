// XID — kanallar-arası normalize İŞ KİMLİĞİ anahtarı (heyet v1 #3).
//
// Sorunun özü anahtar problemiydi, anlam problemi değil: 'TV-42' ile 'tv-42' aynı işin iki
// yazımıdır ve normalize edilince AYNI anahtara düşerler — arama yok, vektör yok, embedder yok;
// tek bir O(1) journal okuması. Böylece "bu iş kimliği daha önce, HERHANGİ BİR KANALDAN yapıldı
// mı?" sorusu sohbet/batch/API/cron ayrımı olmadan cevaplanır.
//
// HEYETİN MİMARİ HÜKMÜ (Hüküm B — tüm hücreleri bağlar): bu kayıt YALNIZ VERİ taşır (kim, hangi
// kanal, ne zaman, hangi runId). "Reddet/sor/atla" kararı buraya GÖMÜLMEZ — karar, okuyanın
// profil hücresinden gelir: aynı kayda headless çarpınca reddeder, assistant çarpınca "bu iş bu
// sabah 03:00 batch'inde yapılmış — yine de yapayım mı?" diye sorar.
//
// Kapsam RESOURCE (kullanıcı): kimliğin sahibi kişidir; kiracı öneki (withOrg) zaten üstünü örter.
// resourceId'siz koşularda XID yazılmaz (sahipsiz kimlik anahtarı, komşu kullanıcının işini
// gölgeleyebilir) — beyanlı araçta bir kez loud-warn edilir, sessiz-inert bırakılmaz.
// GDPR: kişi-silme yüzeyi `purgeResource(journal, resourceId)` — bu aileyi (ve HERMES kişisel
// derslerini) süpürür. purgeThread bu aileye DOKUNMAZ ve thread silinse bile XID işi hatırlar —
// bilinçli: 'başka kanaldan yapılmıştı' hafızasının ömrü konuşmanın değil KİŞİNİN kaydıdır.
import { argsHash } from './hash.js';
import { normalizeId, extractSemFields, type SemanticIdentity } from './semantic-dup.js';
import type { Journal } from './journal.js';
import { claim } from './journal.js';

export interface XidRecord {
  v: 1;
  toolName: string;
  /** Normalize kimlik alanları — soru metinleri bunu gösterir ("createOrder · tv-42"). */
  identity: Record<string, string>;
  /** Tutar alanları — kanallar-arası "amounts DIFFER" uyarısının verisi. */
  amounts: Record<string, number>;
  /** İLK tamamlanmış işin adresi (first-wins; soru/rapor hep ilkini gösterir). */
  first: { runId: string; toolCallId: string; at: number; channel?: string };
}

/** Kimlik değerleri ':' içerebilir; anahtar sınırını bozmasın diye hash'lenir — düz metin kayıtta durur. */
export const xidKey = (resourceId: string, toolName: string, identity: Record<string, string>): string =>
  `xid:res:${resourceId}:${toolName}:${argsHash(identity)}`;

export interface XidPlan {
  resourceId: string;
  toolName: string;
  identity: Record<string, string>;
  amounts: Record<string, number>;
  channel?: string;
}

/** Araç beyanından plan kur — semanticIdentity.keys AYNEN yeniden kullanılır (yeni beyan yok):
 *  kimliği zaten beyan etmiş araç, kanallar-arası korumayı bedavaya alır. */
export function xidPlanOf(id: SemanticIdentity, toolName: string, args: unknown, resourceId: string, channel?: string): XidPlan {
  const fields = extractSemFields(id, args);
  const identity: Record<string, string> = {};
  for (const k of id.keys) identity[k] = normalizeId(fields.identity[k]);
  return { resourceId, toolName, identity, amounts: fields.amounts, channel };
}

/** Başarı choke-point'inden çağrılır — first-wins, best-effort (kayıp bir XID yalnız bir gelecek
 *  uyarısı kaybettirir; işin kendisine asla dokunmaz). */
export async function writeXid(journal: Journal, plan: XidPlan, runId: string, toolCallId: string): Promise<void> {
  try {
    const rec: XidRecord = {
      v: 1,
      toolName: plan.toolName,
      identity: plan.identity,
      amounts: plan.amounts,
      first: { runId, toolCallId, at: journal.now ? await journal.now() : Date.now(), ...(plan.channel ? { channel: plan.channel } : {}) },
    };
    await claim(journal, xidKey(plan.resourceId, plan.toolName, plan.identity), rec);
  } catch { /* best-effort */ }
}

/** Kapıdaki nokta okuma — fail-open: okunamayan kayıt "yok" sayılır (soru sorulamaz, iş asla bloklanmaz). */
export async function readXid(journal: Journal, plan: XidPlan): Promise<XidRecord | undefined> {
  try {
    const rec = await journal.get<XidRecord>(xidKey(plan.resourceId, plan.toolName, plan.identity));
    return rec && rec.v === 1 ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** Soru/rapor metinleri için insan-okur özet: "5 dk önce, sohbetten". */
export function xidWhen(rec: XidRecord, nowMs: number): string {
  const ageMs = Math.max(0, nowMs - rec.first.at);
  const mins = Math.round(ageMs / 60_000);
  const age = mins < 1 ? 'just now' : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
  return rec.first.channel ? `${age}, via ${rec.first.channel}` : age;
}
