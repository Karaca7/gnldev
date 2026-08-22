// @vitest-environment jsdom
// The four background pollers (`useJobs`, `useCacheStats`, `useSchedulerTriggers`, `useApprovals`)
// are now built through `usePolled(capability, …)`, whose `enabled` is `caps.data?.[cap] === true`.
//
// The behaviour being pinned is NOT "the hook returns undefined" — a disabled query returns undefined
// for many reasons, and a stubbed fetch that rejects would produce the same. It is "no background
// traffic": the endpoint must never be REQUESTED. So every assertion here is made on the recorded
// fetch URLs, after the capabilities response has actually landed (waited for through the same
// `useCapabilities` the gate reads) plus a macrotask, so a query that WOULD have fired has had its
// chance to. Each case has its mirror with the capability on, otherwise a broken stub would make the
// negative half pass vacuously.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import {
  useCapabilities, useJobs, useCacheStats, useSchedulerTriggers, useApprovals,
} from '../src/api';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Records every requested URL; `/capabilities` answers exactly the caps object given. */
function stubFetch(caps: Record<string, unknown>) {
  const urls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    urls.push(u);
    const body = u.includes('/capabilities') ? caps : [];
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  }));
  return urls;
}

function wrapper({ children }: { children: ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

/**
 * Renders the polled hook NEXT TO `useCapabilities`, so the test can wait for the exact input the
 * gate reads (`caps.data`) before judging absence — an assertion made before capabilities resolved
 * would prove nothing at all, because the gate is closed while capabilities are in flight anyway.
 */
async function renderGated(hook: () => unknown, caps: Record<string, unknown>) {
  const urls = stubFetch(caps);
  const { result } = renderHook(() => ({ caps: useCapabilities(), polled: hook() }), { wrapper });
  await waitFor(() => expect(result.current.caps.data).toBeTruthy());
  // One real macrotask after the gate has its input: a query that was going to fire has fired by now.
  await new Promise((r) => setTimeout(r, 20));
  return { urls, result };
}

const CASES: { name: string; cap: string; endpoint: string; hook: () => unknown }[] = [
  { name: 'useJobs', cap: 'queue', endpoint: '/jobs', hook: useJobs },
  { name: 'useCacheStats', cap: 'cache', endpoint: '/cache/stats', hook: useCacheStats },
  { name: 'useSchedulerTriggers', cap: 'scheduler', endpoint: '/scheduler/triggers', hook: useSchedulerTriggers },
  { name: 'useApprovals', cap: 'approvals', endpoint: '/approvals', hook: useApprovals },
];

describe('usePolled capability gate', () => {
  for (const c of CASES) {
    // The regression itself: the route stays registered even when the nav row is hidden, so typing the
    // URL used to mount the view and start a 3–5s poll against an endpoint that refuses the caller.
    it(`${c.name}: with caps.${c.cap} === false, ${c.endpoint} is never requested`, async () => {
      const { urls, result } = await renderGated(c.hook, { [c.cap]: false });
      expect(urls.filter((u) => u.endsWith(c.endpoint))).toEqual([]);
      // and the query is genuinely parked, not merely slow
      expect((result.current.polled as { fetchStatus: string }).fetchStatus).toBe('idle');
    });

    // The mirror. Without it a stub that answered nothing at all would make the test above pass.
    it(`${c.name}: with caps.${c.cap} === true, ${c.endpoint} IS requested`, async () => {
      const { urls } = await renderGated(c.hook, { [c.cap]: true });
      expect(urls.filter((u) => u.endsWith(c.endpoint)).length).toBeGreaterThan(0);
    });

    // A capability the server simply does not send (older host, or the flag left off the payload) is
    // not `true` — `usePolled` compares with `=== true`, so `undefined` must also park the poll.
    it(`${c.name}: with caps.${c.cap} absent from the payload, ${c.endpoint} is never requested`, async () => {
      const { urls } = await renderGated(c.hook, { playground: true });
      expect(urls.filter((u) => u.endsWith(c.endpoint))).toEqual([]);
    });
  }

  // Cross-check that the four gates are independent: turning ONE capability on must not open the
  // other three endpoints (a shared/mistyped `cap` argument would show up exactly here).
  it('caps.queue alone opens /jobs and leaves the other three endpoints unrequested', async () => {
    const urls = stubFetch({ queue: true, cache: false, scheduler: false, approvals: false });
    const { result } = renderHook(() => ({
      caps: useCapabilities(),
      jobs: useJobs(), cacheStats: useCacheStats(), triggers: useSchedulerTriggers(), approvals: useApprovals(),
    }), { wrapper });
    await waitFor(() => expect(result.current.caps.data).toBeTruthy());
    await waitFor(() => expect(urls.some((u) => u.endsWith('/jobs'))).toBe(true));
    await new Promise((r) => setTimeout(r, 20));
    expect(urls.filter((u) => u.endsWith('/cache/stats'))).toEqual([]);
    expect(urls.filter((u) => u.endsWith('/scheduler/triggers'))).toEqual([]);
    expect(urls.filter((u) => u.endsWith('/approvals'))).toEqual([]);
  });
});
