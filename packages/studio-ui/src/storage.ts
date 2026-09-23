// Browser storage that cannot take the app down with it.
//
// WHY THIS EXISTS, measured. Every write in this package except `auth.ts` used the `localStorage`
// API bare. `localStorage` is not merely absent in some environments — ACCESS ITSELF THROWS when a
// browser is told to block site data, and `setItem` throws on a full quota (Safari private browsing
// reports a zero quota). `App.tsx`'s theme hook did both, unguarded, at the top of `AppShell`, so
// with storage blocked the whole Studio rendered the ErrorBoundary's "Something went wrong" card
// instead of the app — over a colour preference. Workflows' preset save did it inside the Run
// handler, before the run started, so the button silently did nothing.
//
// The root cause was not carelessness about storage; it was `try/catch` placed where `JSON.parse`
// needed it rather than where storage access did. Playground and Workflows guard their READS —
// because they parse JSON — while the reads that parse nothing (App, Inspector) guard nothing, and
// no write anywhere was guarded. `i18n/getStoredLang` shows the same aim-at-the-wrong-failure: it
// checks `typeof localStorage === 'undefined'` (the node test environment) and then calls
// `getItem` unguarded.
//
// Rule: everything here is a per-viewer CONVENIENCE — a remembered theme, language, selection or
// draft. None of it is worth a blank panel, and none of it may decide whether an action runs. A
// failed read reads as "nothing stored"; a failed write is dropped.

/** Reads a key. Returns null when storage is unavailable, blocked, or empty. */
export function readLocal(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Reads and JSON-parses a key. Returns `fallback` on anything unexpected. */
export function readLocalJson<T>(key: string, fallback: T): T {
  const raw = readLocal(key);
  if (raw == null) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Writes a key. Returns false when the write was dropped — callers may ignore it, never throw on it. */
export function writeLocal(key: string, value: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.setItem(key, value);
    return true;
  } catch {
    return false;
  }
}

/** Removes a key. Same contract as `writeLocal`. */
export function removeLocal(key: string): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    localStorage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
