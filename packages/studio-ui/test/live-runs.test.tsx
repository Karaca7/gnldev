// @vitest-environment jsdom
// F6: if SSE can't connect/drops, useLiveRuns must not silently freeze → falls back to polling.
// F6.6: the SSE URL carries a short-lived ticket instead of the persistent token (sseAuthQuery).
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement, type ReactNode } from 'react';
import { useLiveRuns } from '../src/api';

// A controllable fake EventSource: we trigger error and observe the close.
class FakeES {
  static last: FakeES | null = null;
  url: string;
  closed = false;
  listeners: Record<string, ((e?: unknown) => void)[]> = {};
  constructor(url: string) { this.url = url; FakeES.last = this; }
  addEventListener(type: string, fn: (e?: unknown) => void) { (this.listeners[type] ??= []).push(fn); }
  emit(type: string, event?: unknown) { (this.listeners[type] ?? []).forEach((f) => f(event)); }
  close() { this.closed = true; }
}

function wrapper(qc: QueryClient) {
  return ({ children }: { children: ReactNode }) => createElement(QueryClientProvider, { client: qc }, children);
}

// useLiveRuns now sets up the ES AFTER the ticket fetch (microtask) → drain the microtask queue.
const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

beforeEach(() => {
  vi.stubGlobal('EventSource', FakeES as unknown as typeof EventSource);
  FakeES.last = null;
  localStorage.clear();
});
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); localStorage.clear(); });

describe('useLiveRuns (F6 SSE fallback)', () => {
  it('SSE error → connection closes and runs are invalidated via polling', async () => {
    vi.useFakeTimers();
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useLiveRuns(), { wrapper: wrapper(qc) });
    await flush(); // no token → suffix '' → ES is set up

    const es = FakeES.last!;
    expect(es).toBeTruthy();

    // A 'change' event invalidates while SSE is running
    es.emit('change');
    expect(invalidate).toHaveBeenCalledTimes(1);

    // error → SSE closes, polling starts
    es.emit('error');
    expect(es.closed).toBe(true);

    invalidate.mockClear();
    // The async variant, like every other fake-timer site in this repo: it drains the microtask queue
    // between firings, so a polling callback that grows an `await` before it invalidates keeps
    // working. The sync form fires the timer and asserts in the same tick, which passes today only
    // because the path happens to be synchronous — exactly the assumption `flush()` above exists to
    // avoid making.
    await vi.advanceTimersByTimeAsync(5000);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runs'] });
  });

  it('goes straight to polling when EventSource does not exist at all', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', undefined as unknown as typeof EventSource);
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useLiveRuns(), { wrapper: wrapper(qc) });
    await flush();

    await vi.advanceTimersByTimeAsync(5000);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runs'] });
  });

  it('F6.6: when auth is on, the URL carries a short-lived ?ticket= instead of the persistent token', async () => {
    localStorage.setItem('gnl-token', 'secret-token');
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ ticket: 'T-9' }) })));
    const qc = new QueryClient();
    renderHook(() => useLiveRuns(), { wrapper: wrapper(qc) });
    await flush();

    const es = FakeES.last!;
    expect(es).toBeTruthy();
    expect(es.url).toContain('?ticket=T-9');
    expect(es.url).not.toContain('secret-token'); // the persistent token doesn't leak into the URL
  });

  // API-04: the event body is now informative ({runIds,at}) — the client must patch just the named
  // rows (no full-list refetch), and fall back to the old blanket invalidation for a body it can't
  // make sense of (parse failure, or a legacy plain 'runs' payload from an older server).
  describe('API-04: informative {runIds} events', () => {
    const jsonResponse = (body: unknown) => ({
      ok: true,
      headers: { get: (h: string) => (h === 'content-type' ? 'application/json' : null) },
      json: async () => body,
      clone() { return this; },
    });

    it('a {runIds} event patches only the named row in cached pages — no full ["runs"] invalidation', async () => {
      const qc = new QueryClient();
      // Seed a cached page (the default/unfiltered useRunsPaged key) containing run-a.
      qc.setQueryData(['runs', 'paged', '', '', ''], {
        pages: [{ items: [{ runId: 'run-a', status: 'completed', modelSteps: 1, toolCalls: 0 }], nextCursor: undefined, total: 1 }],
        pageParams: [undefined],
      });
      const fetchMock = vi.fn(async (url: string) => {
        expect(String(url)).toContain('/runs?limit=1&q=run-a');
        return jsonResponse({ items: [{ runId: 'run-a', status: 'completed', modelSteps: 2, toolCalls: 0 }], total: 1 });
      });
      vi.stubGlobal('fetch', fetchMock);
      const qcInvalidate = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useLiveRuns(), { wrapper: wrapper(qc) });
      await flush(); // no token → ES set up directly

      const es = FakeES.last!;
      es.emit('change', { data: JSON.stringify({ runIds: ['run-a'], at: 123 }) });
      await flush(); await flush(); await flush(); // let the fetch()+setQueriesData patch settle

      const cached = qc.getQueryData<{ pages: { items: { runId: string; modelSteps: number }[] }[] }>(['runs', 'paged', '', '', '']);
      expect(cached!.pages[0]!.items[0]!.modelSteps).toBe(2); // patched in place with the fresh value
      expect(qcInvalidate).not.toHaveBeenCalledWith({ queryKey: ['runs'] }); // no blanket invalidation
    });

    it("a legacy plain 'runs' payload (older server) falls back to full invalidation", async () => {
      const qc = new QueryClient();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useLiveRuns(), { wrapper: wrapper(qc) });
      await flush();

      const es = FakeES.last!;
      es.emit('change', { data: 'runs' }); // not JSON → parse fails → fallback
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runs'] });
    });

    it('a body that parses but has no runIds array also falls back to full invalidation', async () => {
      const qc = new QueryClient();
      const invalidate = vi.spyOn(qc, 'invalidateQueries');
      renderHook(() => useLiveRuns(), { wrapper: wrapper(qc) });
      await flush();

      const es = FakeES.last!;
      es.emit('change', { data: JSON.stringify({ at: 1 }) }); // valid JSON, but no `runIds`
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runs'] });
    });
  });
});
