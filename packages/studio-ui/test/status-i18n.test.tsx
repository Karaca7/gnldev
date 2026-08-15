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
    for (const [status, label] of [['completed', 'Completed'], ['suspended', 'Suspended'], ['failed', 'Failed'], ['canceled', 'Cancelled']] as const) {
      const { unmount } = render(<StatusBadge status={status} />);
      expect(screen.getByText(label), `${status} → ${label}`).toBeTruthy();
      unmount();
    }
  });

  it('translates every run status in Turkish', async () => {
    await setLang('tr');
    for (const [status, label] of [['completed', 'Tamamlandı'], ['suspended', 'Askıda'], ['failed', 'Başarısız'], ['canceled', 'İptal edildi']] as const) {
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

  it('renders BOTH spellings of cancelled identically, and never as a failure', async () => {
    // The durable RunStatus spells it 'canceled'; the workflow engine's own statuses spell it
    // 'cancelled'. The same decision rendering as two different states depending on which page you
    // were on is exactly the drift the shared vocabulary exists to prevent. And it is MUTED, not
    // destructive: a run an operator chose to stop is not an incident, and painting it the same red
    // as a 401 is how a list of genuine failures stops being scannable.
    for (const spelling of ['canceled', 'cancelled'] as const) {
      const { container, unmount } = render(<StatusBadge status={spelling} />);
      const cls = container.querySelector('span')?.className ?? '';
      expect(screen.getByText('Cancelled'), `${spelling} → Cancelled`).toBeTruthy();
      expect(cls, `${spelling} must not read as a failure`).not.toContain('destructive');
      expect(cls).toContain('muted-foreground');
      unmount();
    }
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
    for (const k of ['statusCompleted', 'statusSuspended', 'statusFailed', 'statusCancelled']) {
      expect(tr[k], `tr/common.${k} was left in English`).not.toBe(en[k]);
    }
  });

  it('no per-page copies of the status words survive — one vocabulary, one place', () => {
    // The audit measured the drift this breeds: observability's own 'completed' ("Tamamlanan") and
    // common's ("Tamamlandı") rendered for the SAME state on the SAME page. The page now reads
    // through useStatusLabel, and the orphaned copies are deleted — a key nothing reads is where
    // the next drift starts.
    for (const lng of ['en', 'tr'] as const) {
      const bundle = i18n.getResourceBundle(lng, 'observability') as Record<string, string>;
      for (const k of ['completed', 'suspended', 'failed', 'statusAll']) {
        expect(bundle[k], `${lng}/observability.${k} is a duplicate of common.status* — remove it`).toBeUndefined();
      }
    }
  });
});
