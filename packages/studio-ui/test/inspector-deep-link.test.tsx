// @vitest-environment jsdom
// FLOW-07 / FLOW-12 regression guards for Inspector.tsx.
//
// FLOW-07: the URL (`?run=`/`?tab=`) must be the single source of truth for the selected run and the
// active tab — this is what makes "paste a link to this exact run+tab" (the Inspector's basic job as
// an observability tool) and the browser Back button work. The OLD code read `?run=` once and then
// immediately DELETED it from the URL, so the selection only ever lived in localStorage — a pasted/
// shared link and a page refresh landed on the SAME run by accident (localStorage), but a fresh
// browser/incognito tab or a different machine got nothing.
//
// FLOW-12: (a) the "back to run list" arrow used to be `md:hidden` — desktop had NO way to clear the
// selection short of purging the run, so a run purged/retention-swept in another tab stuck its id in
// localStorage forever, reloading into a dead ErrorBox every time. (b) once the run list has loaded
// and doesn't contain the selected run, and a direct fetch for it 404s, the selection must
// self-clear back to the Empty state instead of staying stuck.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useSearchParams } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Inspector } from '../src/views/Inspector';

afterEach(() => {
  cleanup();
  localStorage.clear();
});

vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

const CAPS = {
  resume: false, chat: false, fork: false, playground: false, stream: false, tools: false,
  toolExec: false, toolExecDurable: false, memory: false, workflows: false, workflowExec: false,
  scorers: false, datasets: false, mcp: false, a2a: false,
};

// Exposes the CURRENT router search string in the DOM so tests can assert on it without needing
// direct access to the (internal, unexposed) MemoryRouter history.
function SearchProbe() {
  const [params] = useSearchParams();
  return <div data-testid="search-probe">{params.toString()}</div>;
}

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

// A run whose endpoints all 404 (everything else 200s) — for the FLOW-12(b) auto-clear guard. Uses
// `includes` (not `endsWith`) so every sub-resource of the gone run (/cost, /scores, /trace, …) 404s
// too, same as a real purged run would — not just the plain GET /runs/:id journal fetch.
function stubFetchWith404(routes: Record<string, unknown>, notFoundContains: string) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.includes(notFoundContains)) {
      return {
        ok: false, status: 404,
        headers: { get: () => 'application/json' },
        json: async () => ({ error: 'not found' }),
        clone() { return this; },
      };
    }
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => (key ? routes[key] : []),
    };
  }));
}

function wrap(node: React.ReactNode, initialEntries: string[] = ['/inspector']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter initialEntries={initialEntries}>
      <QueryClientProvider client={qc}>
        {node}
        <SearchProbe />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('Inspector — deep links (FLOW-07) and desktop selection recovery (FLOW-12)', () => {
  it('FLOW-07: selecting a run writes ?run= into the URL (does not stay only in localStorage)', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-1', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-1/cost': { totalTokens: 10, costUsd: 0.001 },
      '/runs/run-1/scores': { scores: {} },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-1')).toBeTruthy());
    fireEvent.click(screen.getByText('run-1'));
    await waitFor(() => expect(screen.getByTestId('search-probe').textContent).toContain('run=run-1'));
  });

  it('FLOW-07: switching tabs writes ?tab= into the URL, and it is shareable/round-trips on a fresh mount', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-1', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-1/cost': { totalTokens: 10, costUsd: 0.001 },
      '/runs/run-1/scores': { scores: {} },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-1')).toBeTruthy());
    fireEvent.click(screen.getByText('run-1'));
    // A11Y-06: Tabs now uses the real ARIA tabs pattern (role="tab", not "button").
    fireEvent.click(await screen.findByRole('tab', { name: 'Trace' }));
    await waitFor(() => {
      const s = screen.getByTestId('search-probe').textContent!;
      expect(s).toContain('run=run-1');
      expect(s).toContain('tab=trace');
    });
  });

  it('FLOW-07: a pasted deep link (?run=&tab=) selects that run and opens that tab, and does NOT strip the params from the URL', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-1', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-1/cost': { totalTokens: 10, costUsd: 0.001 },
      '/runs/run-1/scores': { scores: {} },
      '/runs/run-1/trace': { spans: [], totalMs: 0, cost: { costUsd: 0 } },
    });
    wrap(<Inspector />, ['/inspector?run=run-1&tab=trace']);
    // The run is selected immediately (RunDetail renders its header) — same as the Playground "Inspect" link before this fix.
    await waitFor(() => expect(screen.getByText('run-1')).toBeTruthy());
    // And the Trace tab is the active one (its empty-state text, since spans is empty here).
    await waitFor(() => expect(screen.getByText(/No spans/)).toBeTruthy());
    // THE regression this guards: the old code deleted `run` from the URL right after reading it.
    const s = screen.getByTestId('search-probe').textContent!;
    expect(s).toContain('run=run-1');
    expect(s).toContain('tab=trace');
  });

  it('FLOW-12(a): the "back to run list" button is visible at desktop widths too (no md:hidden), and clears the selection', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-1', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-1/cost': { totalTokens: 10, costUsd: 0.001 },
      '/runs/run-1/scores': { scores: {} },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-1')).toBeTruthy());
    fireEvent.click(screen.getByText('run-1'));
    const back = await screen.findByTitle('Back to run list');
    expect(back.className).not.toMatch(/md:hidden/);
    fireEvent.click(back);
    await waitFor(() => expect(screen.getByText('Select a run on the left → timeline · time-travel · trace · forks.')).toBeTruthy());
  });

  it('FLOW-12(b): a run gone from the (unfiltered) run list whose direct fetch 404s auto-clears the selection to the Empty state', async () => {
    // 'ghost-run' is NOT among /runs?limit=50's items (already purged/swept elsewhere) and its direct
    // GET /runs/ghost-run 404s — both conditions the guard requires before it self-clears.
    stubFetchWith404(
      {
        '/capabilities': CAPS,
        '/runs?limit=50': { items: [{ runId: 'run-1', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      },
      '/runs/ghost-run',
    );
    wrap(<Inspector />, ['/inspector?run=ghost-run']);
    await waitFor(() => expect(screen.getByText('Select a run on the left → timeline · time-travel · trace · forks.')).toBeTruthy());
    // The dead id must not resurrect itself into the URL or localStorage.
    expect(screen.getByTestId('search-probe').textContent).not.toContain('ghost-run');
    expect(localStorage.getItem('gnl-insp-run')).toBeNull();
  });
});
