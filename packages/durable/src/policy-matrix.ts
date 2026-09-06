// KULLANIM PROFİLİ × YAN-ETKİ SINIFI politika matrisi — heyet kararının kodu (7 Eyl 2026).
//
// İki beyan, motoru kalibre eder: araç kendi YAN-ETKİ SINIFINI söyler (tekrarın bedeli işe göre
// değişir), giriş noktası KULLANIM PROFİLİNİ söyler (soracak insan var mı?). Kesişimden tekrar
// davranışı çıkar — geliştirici hücre hücre politika yazmaz.
//
// Heyetin bağlayıcı hükümleri (ihlali bloker):
//   - Marker/kimlik kayıtları VERİ taşır, karar taşımaz — karar OKUYAN profilin hücresinden gelir
//     (aynı ize headless çarpınca reddeder, assistant çarpınca insanca sorar).
//   - "Bir sorunun bedeli 3 saniyedir" aksiyomu YALNIZ assistant hücrelerinde geçerlidir; headless'a
//     ihraç edilemez (gece 03:00'te bedel = kilit TTL'i + SLA + askı yığını).
//   - critical'da tek-beden sertlik kuralın ihlali değil KULLANICININ AÇIK TERCİHİDİR; tek gevşeme
//     `idempotent: true` BEYANLI araçta (soru hiçbir bilgi katmaz — sessiz-replay + warn izi).
//   - Zarf/iz hiçbir hücrede incelmez: sessiz olabilir, görünmez olamaz.

/** Aracın beyanı: tekrarın BEDELİ. Beyansız araç profilin default hücresine düşer (bugünkü davranış). */
export type EffectClass =
  | 'transactional'      // para/stok — tekrar = zarar
  | 'notification'       // e-posta/bildirim — tekrar = can sıkıcı, felaket değil
  | 'idempotent-write'   // upsert/senkron — tekrar = zararsız (matematik zaten koruyor)
  | 'delete'             // tekrarı zararsız, YANLIŞI felaket (asıl kapı confirm/hedef doğrulama)
  | 'external-api';      // kendi idempotency-key'i olan dış servis — anahtar sağlayıcıya taşınır

export type DupAction = 'off' | 'warn' | 'reflect' | 'block' | 'suspend' | 'skip';
/** Hücre-içi `semantic` BİLİNÇLİ YOK (denetçi bloker): semantik config yalnız ÜST seviyede taşınır
 *  ki validator/freeze/strip kapıları tek noktayı görsün — hücreye gömülen closure o kapıların
 *  hepsinden kaçıyordu. */
export interface DupSpec { action: DupAction; scope?: 'run' | 'thread'; ttlMs?: number }

/**
 * Nihai matris — hakem sentezinin v1 hücreleri. 'skip' = koşmadan "daha önce yapılmıştı" sonucu
 * döndür (model bunu kullanıcıya görünür şekilde anlatır; incident izi düşer — sessiz değil).
 * assistant×notification hücresi v1'de 'suspend' (heyet Hüküm A: soft-interrupt yüzeyi v2'de
 * gelene dek skip'in tek dürüst hali sormaktır; yüzey gelince 'skip'e iner).
 */
export const PRESET_MATRIX: Record<'assistant' | 'headless' | 'critical', Record<EffectClass, DupSpec>> = {
  assistant: {
    transactional: { action: 'suspend', scope: 'thread' },
    notification: { action: 'suspend', scope: 'thread' }, // v2: soft-interrupt gelince 'skip'
    'idempotent-write': { action: 'off' },
    delete: { action: 'skip', scope: 'thread' }, // "zaten silinmişti" — soru değil görünür not (ilk çağrının kapısı confirm'dür)
    'external-api': { action: 'off' }, // anahtar sağlayıcıya geçer; replay doğal yoldan gelir
  },
  headless: {
    transactional: { action: 'block', scope: 'thread' }, // soracak insan yok: typed red → DLQ + incident
    notification: { action: 'skip', scope: 'thread' },
    'idempotent-write': { action: 'off' },
    delete: { action: 'skip', scope: 'thread' },
    'external-api': { action: 'off' },
  },
  critical: {
    transactional: { action: 'suspend', scope: 'thread' },
    notification: { action: 'suspend', scope: 'thread' }, // sınıf ayrımı yapılmaz — azami tören bilinçli seçimdir
    'idempotent-write': { action: 'warn', scope: 'thread' }, // beyanlı matematiğe soru sormak bilgi katmaz; iz yine düşer
    delete: { action: 'suspend', scope: 'thread' },
    'external-api': { action: 'suspend', scope: 'thread' },
  },
};

/** Profilin, beyansız (effectClass'sız) araçlar için default hücresi — bugünkü tekil davranışın devamı. */
export const PRESET_DEFAULT: Record<'assistant' | 'headless' | 'critical', DupSpec> = {
  assistant: { action: 'suspend', scope: 'thread' },
  headless: { action: 'block', scope: 'thread' },
  critical: { action: 'suspend', scope: 'thread' },
};
