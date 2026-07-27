// @vitest-environment jsdom
// Scheduler view: pure logic (duration/trigger/relative-time formatting + status tone threshold — the
// server already returns the raw nextRunAt (epoch ms), only the PRESENTATION is derived here) + render
// (table, empty state, capability-gated "not enabled" message, error state).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Scheduler, formatDurationMs, formatSchedule, relativeToNow, statusTone } from '../src/views/Scheduler';
import '../src/i18n'; // Scheduler uses translations — needs i18n initialized in the test too (test-side counterpart of the side effect in main.tsx).

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

function stubFetch(routes: Record<string, unknown>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => (key ? routes[key] : []),
    };
  }));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('formatDurationMs (pure)', () => {
  it('picks the largest meaningful unit based on the thresholds (EN default output)', () => {
    expect(formatDurationMs(500)).toBe('500ms');
    expect(formatDurationMs(5000)).toBe('5s');
    expect(formatDurationMs(90_000)).toBe('1.5m');
    expect(formatDurationMs(2 * 3_600_000)).toBe('2h');
    expect(formatDurationMs(3 * 86_400_000)).toBe('3d');
  });
  it('returns "—" for an invalid/negative value', () => {
    expect(formatDurationMs(NaN)).toBe('—');
    expect(formatDurationMs(-1)).toBe('—');
  });
});

describe('formatSchedule (pure)', () => {
  it('cron: shows the raw expression', () => {
    expect(formatSchedule({ kind: 'cron', value: '*/5 * * * *' })).toBe('cron */5 * * * *');
  });
  it('every: converts to a readable period (EN default output)', () => {
    expect(formatSchedule({ kind: 'every', value: 60_000 })).toBe('every 1m');
  });
  it('at: one-time label (EN default output)', () => {
    expect(formatSchedule({ kind: 'at', value: 1_700_000_000_000 })).toBe('one-time');
  });
});

describe('relativeToNow (pure)', () => {
  it('in the future: "in X" (EN default output)', () => {
    expect(relativeToNow(10_000, 0)).toBe('in 10s');
  });
  it('in the past: "X ago" (EN default output)', () => {
    expect(relativeToNow(0, 10_000)).toBe('10s ago');
  });
  it('within 1s: "now" (EN default output)', () => {
    expect(relativeToNow(1000, 500)).toBe('now');
  });
});

describe('statusTone (pure)', () => {
  it('failed → destructive, done → success', () => {
    expect(statusTone({ status: 'failed', nextRunAt: 0 }, 1000)).toBe('destructive');
    expect(statusTone({ status: 'done', nextRunAt: 0 }, 1000)).toBe('success');
  });
  it('pending + overdue → warning, pending + on time → muted', () => {
    expect(statusTone({ status: 'pending', nextRunAt: 500 }, 1000)).toBe('warning');
    expect(statusTone({ status: 'pending', nextRunAt: 2000 }, 1000)).toBe('muted');
  });
});

const CAPS_NO_SCHED = { resume: false, chat: false, fork: false, playground: false, stream: false, tools: false, scheduler: false };

describe('Scheduler view', () => {
  it('when caps.scheduler is off, shows the "turned off" EmptyState; endpoints are never called', async () => {
    // Studio audit fix: the bare one-line "not enabled" message was replaced with a richer
    // EmptyState (icon + title + description), same primitive as the "no triggers" case below.
    stubFetch({ '/capabilities': CAPS_NO_SCHED });
    wrap(<Scheduler />);
    await waitFor(() => expect(screen.getByText('Scheduler is turned off')).toBeTruthy());
  });

  it('shows an empty-state message when there are no triggers', async () => {
    // Studio audit fix: the bare one-line "No triggers defined." was replaced with a richer
    // EmptyState (icon + title + description) — assert on the new title text instead.
    stubFetch({ '/capabilities': { ...CAPS_NO_SCHED, scheduler: true }, '/scheduler/triggers': [] });
    wrap(<Scheduler />);
    await waitFor(() => expect(screen.getByText('No triggers yet')).toBeTruthy());
  });

  it('renders the trigger table (id, workflow, trigger, misfire, status/attempts)', async () => {
    stubFetch({
      '/capabilities': { ...CAPS_NO_SCHED, scheduler: true },
      '/scheduler/triggers': [
        { id: 'daily', name: 'wf-report', kind: 'cron', value: '0 9 * * *', nextRunAt: 1_700_000_000_000, attempts: 0, maxAttempts: 5, fireCount: 3, status: 'pending', misfire: 'skip' },
        { id: 'f1', name: 'wf-fail', kind: 'at', value: 0, nextRunAt: 0, attempts: 1, maxAttempts: 1, fireCount: 0, status: 'failed', misfire: 'skip', lastError: 'connection dropped' },
      ],
    });
    wrap(<Scheduler />);
    await waitFor(() => expect(screen.getByText('daily')).toBeTruthy());
    expect(screen.getByText('wf-report')).toBeTruthy();
    expect(screen.getByText('cron 0 9 * * *')).toBeTruthy();
    expect(screen.getByText('f1')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('connection dropped')).toBeTruthy();
    expect(screen.getByText('1/1')).toBeTruthy();
  });

  it('shows an ErrorBox on error', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (String(url).endsWith('/capabilities')) {
        return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ...CAPS_NO_SCHED, scheduler: true }) };
      }
      return {
        ok: false, status: 500, statusText: 'Internal Server Error', headers: { get: () => 'application/json' },
        json: async () => ({ error: 'boom' }),
        clone: () => ({ json: async () => ({ error: 'boom' }) }),
      };
    }));
    wrap(<Scheduler />);
    await waitFor(() => expect(screen.getByText('boom')).toBeTruthy());
  });
});
