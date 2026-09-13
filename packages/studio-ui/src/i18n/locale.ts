// Single source of truth for the BCP-47 locale used by `Intl` / `toLocale*String` formatting.
//
// Why this is a separate module (and not part of i18n/index.ts): index.ts INITIALIZES i18next as an
// import side effect and its getStoredLang() touches `localStorage`, which does not exist in the
// Node (jsdom-less) test environment — see the comment block at the top of views/Organizations.tsx.
// Pure formatting helpers such as `fmtTok` must stay importable from a node test, so this module
// only reads the shared i18next singleton and never initializes it.
//
// Product default is ENGLISH: an uninitialized or unknown language formats as 'en-US'; only Turkish
// opts into 'tr-TR'. Hardcoding 'tr-TR' at a call site is the bug this helper exists to prevent —
// it printed `1.234.567` for token counts in an otherwise English UI.
import i18n from 'i18next';

/**
 * Active formatting locale. Call it at RENDER time (not at module scope): components that read it
 * re-render on a language switch through their own `useTranslation()` subscription, and this
 * function then returns the new locale.
 */
export function currentLocale(): string {
  // `startsWith` rather than `=== 'tr'`, so a region-qualified language tag ('tr-TR', 'tr-CY')
  // coming from a future language detector still formats as Turkish instead of silently falling
  // back to English. `language` is `undefined` until i18next is initialized.
  return i18n.language?.toLowerCase().startsWith('tr') ? 'tr-TR' : 'en-US';
}
