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
  emit(type: string) { (this.listeners[type] ?? []).forEach((f) => f()); }
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
    vi.advanceTimersByTime(5000);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['runs'] });
  });

  it('goes straight to polling when EventSource does not exist at all', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('EventSource', undefined as unknown as typeof EventSource);
    const qc = new QueryClient();
    const invalidate = vi.spyOn(qc, 'invalidateQueries');
    renderHook(() => useLiveRuns(), { wrapper: wrapper(qc) });
    await flush();

    vi.advanceTimersByTime(5000);
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
});
