// @vitest-environment jsdom
// "Cache disabled" and "unavailable in your organization scope" are different sentences, and the
// operator who reads the wrong one goes to look at the wrong config.
//
// The API refuses honestly — `403 org_scope_refused`, naming the fix. The capability booleans then
// collapse "this deployment has no cache" and "your organization cannot reach this deployment's cache"
// into one `false`, so the views rendered their ordinary not-configured state. `scopeRefused` carries
// the difference; these tests check the views actually use it.
//
// BOTH DIRECTIONS, because a view that always showed the refusal would pass a one-sided test: each
// view is rendered once scope-refused and once merely absent, and the two must differ.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Jobs } from '../src/views/Jobs';
import { Cache } from '../src/views/Cache';
import { Knowledge } from '../src/views/Knowledge';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

/**
 * A deployment where the capability is off. `scopeRefused` distinguishes WHY: present means the
 * organization cannot reach a host object the deployment does have; absent means it has none.
 */
function stubFetch(scopeRefused: string[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes('/capabilities')) {
      return new Response(JSON.stringify({
        // Every gated capability off, exactly as the server reports it to a refused caller.
        queue: false, queueManage: false, cache: false, cacheManage: false, knowledge: false,
        memory: false, workflowManage: false, scopeRefused,
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    // The endpoints behind them are refused; the views must not need them to decide what to show.
    return new Response(JSON.stringify({ code: 'org_scope_refused', error: 'refused' }),
      { status: 403, headers: { 'content-type': 'application/json' } });
  }));
}

function renderView(node: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}><MemoryRouter>{node}</MemoryRouter></QueryClientProvider>);
}

/** The refusal wording, matched on its distinguishing half rather than the whole sentence. */
const REFUSAL = /organization scope/i;

const VIEWS = [
  ['Jobs', 'queue', () => <Jobs />] as const,
  ['Cache', 'cache', () => <Cache />] as const,
  ['Knowledge', 'knowledge', () => <Knowledge />] as const,
];

describe('a capability that is off because of the caller\'s organization scope', () => {
  it.each(VIEWS)('%s says so, rather than "not configured"', async (_name, cap, View) => {
    stubFetch([cap]);
    renderView(<View />);

    await waitFor(() => {
      expect(screen.getByText(REFUSAL),
        'the view shows its ordinary empty state for a scope refusal — the operator is sent to check '
        + 'deployment config for something that is configured and simply not theirs')
        .toBeTruthy();
    });
  });

  // The half that makes the above mean something: a view that hardcoded the refusal would pass it.
  it.each(VIEWS)('%s shows the ORDINARY empty state when the capability is merely absent', async (_name, _cap, View) => {
    stubFetch([]); // nothing refused — the deployment simply has no queue/cache/vectors
    renderView(<View />);

    await waitFor(() => expect(document.body.textContent, 'the view rendered nothing at all').toBeTruthy());
    expect(screen.queryByText(REFUSAL),
      'the view claims an organization-scope refusal on a deployment that has no such host object at '
      + 'all — the refusal is hardcoded, so the test above proves nothing')
      .toBeNull();
  });

  // And the two states must actually differ on screen, not merely differ in which branch ran.
  it.each(VIEWS)('%s renders visibly different text in the two cases', async (_name, cap, View) => {
    stubFetch([cap]);
    const refused = renderView(<View />);
    await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());
    const refusedText = refused.container.textContent ?? '';
    cleanup();

    stubFetch([]);
    const absent = renderView(<View />);
    await waitFor(() => expect(absent.container.textContent).toBeTruthy());
    const absentText = absent.container.textContent ?? '';

    expect(refusedText, 'the refused and the unconfigured screens read identically').not.toBe(absentText);
  });
});

describe('isScopeRefused', () => {
  // The pure predicate, including the case an older server produces.
  it('is false when the server sends no scopeRefused at all', async () => {
    const { isScopeRefused } = await import('../src/api');
    expect(isScopeRefused({ queue: false } as never, 'queue'),
      'an older server without the field is read as a refusal, so every unconfigured deployment claims one')
      .toBe(false);
  });

  it('is false for a capability not in the list, true for one that is', async () => {
    const { isScopeRefused } = await import('../src/api');
    const caps = { queue: false, cache: false, scopeRefused: ['queue'] } as never;
    expect(isScopeRefused(caps, 'queue')).toBe(true);
    expect(isScopeRefused(caps, 'cache')).toBe(false);
  });

  it('is false when caps have not loaded yet', async () => {
    const { isScopeRefused } = await import('../src/api');
    expect(isScopeRefused(undefined, 'queue')).toBe(false);
  });
});
