// @vitest-environment jsdom
// Wiring of the new "Network" tab in Inspector (tab → useRunNetwork → empty state) and the cost
// panel's byModel/cachedTokens display. The actual xyflow/dagre graph layout (when routes/steps are
// populated) can only be visually verified in a real browser — BROWSER CHECK, not tested here.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n'; // EN default language so Inspector's t() calls use the real translation (same pattern as views.test.tsx).
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

const CAPS = {
  resume: false, chat: false, fork: false, playground: false, stream: false, tools: false,
  toolExec: false, toolExecDurable: false, memory: false, workflows: false, workflowExec: false,
  scorers: false, datasets: false, mcp: false, a2a: false,
};

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('Inspector — Network tab + cost details', () => {
  it('"Network" tab: shows a clear empty state when routes/steps are empty', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-1', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-1/cost': { totalTokens: 10, costUsd: 0.001 },
      '/runs/run-1/scores': { scores: {} },
      '/runs/run-1/network': { routes: [], steps: [] },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-1')).toBeTruthy());
    fireEvent.click(screen.getByText('run-1'));
    fireEvent.click(await screen.findByText('Network'));
    await waitFor(() =>
      expect(screen.getByText(/didn't use the dynamic agent network/)).toBeTruthy(),
    );
  });

  it('cost panel: shows the cachedTokens and byModel breakdown', async () => {
    // API-11: the Cost tab is now sourced from GET /runs/:id/trace's `cost` field (same RunCost shape
    // the old, now-removed /cost endpoint call used to return) instead of a separate /cost request —
    // see RunDetail's `traceQ`/`cost` in Inspector.tsx.
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-2', status: 'completed', modelSteps: 2, toolCalls: 0 }], total: 1 },
      '/runs/run-2/trace': {
        totalMs: 0,
        spans: [],
        cost: {
          totalTokens: 500, costUsd: 0.02, cachedTokens: 120,
          byModel: { 'openai/gpt-4o-mini': { calls: 2, tokens: 500, costUsd: 0.02 } },
        },
      },
      '/runs/run-2/scores': { scores: {} },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-2')).toBeTruthy());
    fireEvent.click(screen.getByText('run-2'));
    // The byModel/cached breakdown now lives in the dedicated "Cost" tab (new design — the run header
    // meta grid shows the labeled at-a-glance COST; the full breakdown is one click away, like the mockup).
    // A11Y-06: real ARIA tabs pattern — query by role="tab", not "button".
    fireEvent.click(await screen.findByRole('tab', { name: 'Cost' }));
    // ^500: only the top summary ("500 tok · $…"), so it doesn't clash with "2 calls · 500 tok · …" in the byModel breakdown.
    await screen.findByText(/^500 tok/);
    expect(screen.getByText(/120 cache/)).toBeTruthy();
    // The model id now appears in BOTH the run-header meta grid (MODEL cell) and the Cost-tab byModel
    // breakdown → getAllByText (≥1). The unique breakdown line below still pins the <details> content.
    expect(screen.getAllByText('openai/gpt-4o-mini').length).toBeGreaterThan(0);
    expect(screen.getByText(/2 calls · 500 tok · \$0\.0200/)).toBeTruthy();
  });

  // API-10 regression guard: the client used to call GET /metrics/runs with NO limit at all — the
  // server downloaded (and, for un-materialized rows, fully re-read) a metrics row for EVERY run in
  // the journal on every 10s poll, no matter how many rows the list actually renders (RUNS_PAGE_SIZE=50).
  // useMetricsRuns must always send a `limit` query param (see api.ts).
  it('API-10: GET /metrics/runs is requested WITH a limit query, not the unbounded full list', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-3', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/metrics/runs?limit=200': {
        runs: [{ runId: 'run-3', status: 'completed', modelSteps: 1, toolCalls: 0, startTs: 1, durationMs: 10, costUsd: 0.001, totalTokens: 5 }],
      },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-3')).toBeTruthy());
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const metricsCall = calls.find(([u]: any[]) => String(u).includes('/metrics/runs'));
    expect(metricsCall).toBeTruthy();
    expect(String(metricsCall![0])).toMatch(/[?&]limit=\d+/);
  });

  // API-11 regression guard: selecting a run used to ALWAYS fire GET /runs/:id/cost (useCost), even
  // though its data (a) only ever renders inside the Cost tab, and (b) is already included in GET
  // /runs/:id/trace's `cost` field. useCost is gone — the Cost tab (and its tab-visibility check) must
  // come from useTrace instead, so /cost is never requested at all.
  it("API-11: selecting a run does NOT fetch /runs/:id/cost (Cost tab is sourced from /trace)", async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-4', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-4/trace': { totalMs: 5, spans: [], cost: { totalTokens: 10, costUsd: 0.001 } },
      '/runs/run-4/scores': { scores: {} },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-4')).toBeTruthy());
    fireEvent.click(screen.getByText('run-4'));
    // The Cost tab appears (proving `cost` resolved from /trace) without ever hitting /cost directly.
    await screen.findByRole('tab', { name: 'Cost' });
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const costCall = calls.find(([u]: any[]) => String(u).includes('/cost'));
    expect(costCall).toBeUndefined();
  });
});
