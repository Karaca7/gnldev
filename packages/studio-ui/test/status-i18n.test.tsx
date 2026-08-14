// @vitest-environment jsdom
// Status was the one vocabulary Studio never translated.
//
// StatusBadge rendered `{status}` verbatim, so a Turkish operator read "completed" and "suspended" in
// English on every run row, table and detail pane. The Inspector's filter tabs did the same — only
// 'all' went through t(). The strings existed in the locale files (inspector.json has "suspended":
// "askıda"); nothing used them for this.
//
// Adding 'failed' made it worse rather than better: a new state, also untranslated, in the place an
// operator looks when something is wrong.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import i18n from '../src/i18n/index.js';
import { StatusBadge } from '../src/components.js';

const setLang = async (lng: 'en' | 'tr') => { await i18n.changeLanguage(lng); };

describe('StatusBadge speaks the reader’s language', () => {
  beforeEach(async () => { await setLang('en'); });
  afterEach(cleanup);

  it('translates every run status in English', async () => {
    for (const [status, label] of [['completed', 'Completed'], ['suspended', 'Suspended'], ['failed', 'Failed']] as const) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label), `${status} → ${label}`).toBeTruthy();
      unmount();
    }
  });

  it('translates every run status in Turkish', async () => {
    await setLang('tr');
    for (const [status, label] of [['completed', 'Tamamlandı'], ['suspended', 'Askıda'], ['failed', 'Başarısız']] as const) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label), `${status} → ${label}`).toBeTruthy();
      unmount();
    }
  });

  it('leaves an unknown status exactly as it was', async () => {
    // The badge is fed statuses from runs, jobs AND workflows. One it does not know must still render
    // Its raw string — not vanish, and not show a missing-key marker.
    render(<StatusBadge status="quarantined" />);
    expect(screen.getByText('quarantined')).toBeTruthy();
  });

  it('keeps failure visually distinct from success', async () => {
    const { container, unmount } = render(<StatusBadge status="failed" />);
    expect(container.querySelector('span')?.className).toContain('destructive');
    unmount();
    const ok = render(<StatusBadge status="completed" />);
    expect(ok.container.querySelector('span')?.className).toContain('success');
  });
});

describe('both locales define the whole status vocabulary', () => {
  const KEYS = [
    'statusRunning', 'statusCompleted', 'statusSuspended', 'statusFailed',
    'statusCancelled', 'statusPending', 'statusNeedsApproval', 'statusAll',
  ];

  it('has every key in en and tr, with no untranslated leftovers', async () => {
    for (const lng of ['en', 'tr'] as const) {
      const bundle = i18n.getResourceBundle(lng, 'common') as Record<string, string>;
      for (const k of KEYS) {
        expect(bundle[k], `${lng}/common.${k} is missing`).toBeTruthy();
      }
    }
    // A Turkish bundle that merely copies the English string is a missing translation wearing a
    // Translation's clothes — these particular words differ in both languages.
    const en = i18n.getResourceBundle('en', 'common') as Record<string, string>;
    const tr = i18n.getResourceBundle('tr', 'common') as Record<string, string>;
    for (const k of ['statusCompleted', 'statusSuspended', 'statusFailed']) {
      expect(tr[k], `tr/common.${k} was left in English`).not.toBe(en[k]);
    }
  });

  it('observability names the failed bucket in both languages', () => {
    for (const lng of ['en', 'tr'] as const) {
      const bundle = i18n.getResourceBundle(lng, 'observability') as Record<string, string>;
      expect(bundle.failed, `${lng}/observability.failed is missing`).toBeTruthy();
    }
  });
});
