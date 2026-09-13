// Formatting locale: the product default is ENGLISH. Regression guard for the bug where six views
// hardcoded 'tr-TR' in toLocale*String calls, so every user — including one with the English UI —
// saw Turkish number and date formatting (`1.234.567`, `24 Ağu`).
//
// NODE environment on purpose: these are pure formatting helpers, no DOM needed. It also proves the
// helper is importable WITHOUT i18n/index.ts's localStorage-dependent init (see
// src/i18n/locale.ts and the comment block at the top of src/views/Organizations.tsx).
import { describe, it, expect, afterEach } from 'vitest';
import i18n from 'i18next';
import { currentLocale } from '../src/i18n/locale';
import { fmtTok } from '../src/views/Organizations';
import { buildScoreTrend } from '../src/views/Observability';

// The helper reads the shared i18next singleton; `language` is the only state these tests touch.
function setLang(lang: string | undefined): void {
  (i18n as unknown as { language: string | undefined }).language = lang;
}
afterEach(() => { setLang(undefined); });

describe('currentLocale', () => {
  it('no language selected (i18next not initialized) → en-US, NOT tr-TR', () => {
    expect(currentLocale()).toBe('en-US');
  });

  it("explicit 'en' → en-US", () => {
    setLang('en');
    expect(currentLocale()).toBe('en-US');
  });

  it("'tr' → tr-TR (Turkish is the opt-in, not the default)", () => {
    setLang('tr');
    expect(currentLocale()).toBe('tr-TR');
  });

  it("a region-qualified Turkish tag ('tr-TR') also maps to tr-TR", () => {
    setLang('tr-TR');
    expect(currentLocale()).toBe('tr-TR');
  });

  it('an unknown language falls back to en-US instead of leaking Turkish formatting', () => {
    setLang('de');
    expect(currentLocale()).toBe('en-US');
  });
});

describe('view formatting uses the active locale', () => {
  it('token counts: default language groups with commas (en-US), Turkish with dots', () => {
    expect(fmtTok(1234567)).toBe('1,234,567');
    expect(fmtTok(1234567)).not.toContain('.');
    setLang('tr');
    expect(fmtTok(1234567)).toBe('1.234.567');
  });

  it('score-trend date labels: default language is not Turkish', () => {
    const { points } = buildScoreTrend([{ day: '2026-08-24', fields: { 'score:acc:avg': 0.5 } } as never]);
    const label = String(points[0]!.label);
    // 'Aug' in English, 'Ağu' in Turkish — the same Date, formatted by the active language.
    expect(label).toContain('Aug');
    setLang('tr');
    const trLabel = String(buildScoreTrend([{ day: '2026-08-24', fields: {} } as never]).points[0]!.label);
    expect(trLabel).toContain('Ağu');
    expect(trLabel).not.toBe(label);
  });
});
