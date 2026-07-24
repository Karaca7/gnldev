// @vitest-environment jsdom
// Cache view: pure logic (hit-rate formatting + tone threshold — the server already computes hitRate,
// only the PRESENTATION is derived here) + render/interaction (cards, empty state, capability-gated invalidate flow).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Cache, formatHitRate, hitRateTone } from '../src/views/Cache';

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
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    const entry = key ? routes[key] : [];
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => (typeof entry === 'function' ? entry(init) : entry),
    };
  }));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('formatHitRate (pure)', () => {
  it('converts a 0..1 ratio to a percentage', () => {
    expect(formatHitRate(0)).toBe('0.0%');
    expect(formatHitRate(1)).toBe('100.0%');
    expect(formatHitRate(2 / 3)).toBe('66.7%');
  });
  it('returns "—" for a non-finite value (0/0 division guard)', () => {
    expect(formatHitRate(NaN)).toBe('—');
    expect(formatHitRate(Infinity)).toBe('—');
  });
});

describe('hitRateTone (pure)', () => {
  it('neutral when there are no requests at all', () => {
    expect(hitRateTone(0, 0)).toBe('muted');
  });
  it('thresholds: >=0.7 success, >=0.4 warning, below that destructive', () => {
    expect(hitRateTone(0.9, 10)).toBe('success');
    expect(hitRateTone(0.7, 10)).toBe('success');
    expect(hitRateTone(0.5, 10)).toBe('warning');
    expect(hitRateTone(0.4, 10)).toBe('warning');
    expect(hitRateTone(0.1, 10)).toBe('destructive');
  });
});

const CAPS_NO_CACHE = { resume: false, chat: false, fork: false, playground: false, stream: false, tools: false, cache: false };

describe('Cache view', () => {
  it('when caps.cache is off, shows the "not enabled" message; endpoints are never called', async () => {
    stubFetch({ '/capabilities': CAPS_NO_CACHE });
    wrap(<Cache />);
    await waitFor(() => expect(screen.getByText('Cache disabled')).toBeTruthy());
  });

  it('shows the stats as cards (hit/miss/rate/size)', async () => {
    stubFetch({
      '/capabilities': { ...CAPS_NO_CACHE, cache: true },
      '/cache/stats': { hits: 8, misses: 2, hitRate: 0.8, size: 5 },
    });
    wrap(<Cache />);
    await waitFor(() => expect(screen.getByText('80.0%')).toBeTruthy());
    expect(screen.getByText('8')).toBeTruthy();
    expect(screen.getByText('2')).toBeTruthy();
    expect(screen.getByText('5')).toBeTruthy();
    expect(screen.getByText('10 requests')).toBeTruthy();
  });

  it('when there are no hits/misses at all, adds an empty-state message (cards still show)', async () => {
    stubFetch({
      '/capabilities': { ...CAPS_NO_CACHE, cache: true },
      '/cache/stats': { hits: 0, misses: 0, hitRate: 0, size: 0 },
    });
    wrap(<Cache />);
    await waitFor(() => expect(screen.getByText(/No hits\/misses yet/)).toBeTruthy());
  });

  it('when cacheManage is off, the invalidate panel is not shown', async () => {
    stubFetch({
      '/capabilities': { ...CAPS_NO_CACHE, cache: true, cacheManage: false },
      '/cache/stats': { hits: 1, misses: 1, hitRate: 0.5, size: 1 },
    });
    wrap(<Cache />);
    await waitFor(() => expect(screen.getByText('50.0%')).toBeTruthy());
    expect(screen.queryByText('Manual invalidate')).toBeNull();
  });

  it('when cacheManage is on, invalidate: confirmation dialog → POST /cache/invalidate (key in body)', async () => {
    stubFetch({
      '/capabilities': { ...CAPS_NO_CACHE, cache: true, cacheManage: true },
      '/cache/stats': { hits: 1, misses: 1, hitRate: 0.5, size: 1 },
      '/cache/invalidate': { ok: true, deleted: 1 },
    });
    wrap(<Cache />);
    await waitFor(() => expect(screen.getByText('Manual invalidate')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Invalidate key'), { target: { value: 'embeds:refund' } });
    fireEvent.click(screen.getByText('Clear'));
    await screen.findByText("Invalidate 'embeds:refund'?"); // dialog opened
    // the confirm button in the dialog also carries the "Clear" text — the last one is the dialog's
    const confirmBtn = (await screen.findAllByText('Clear')).at(-1)!;
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const post = calls.find(([u, init]: any[]) => String(u).endsWith('/cache/invalidate') && init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse((post![1] as any).body)).toEqual({ key: 'embeds:refund' });
    });
  });
});
