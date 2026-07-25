// @vitest-environment jsdom
// STATE-08 regression: the "what-if fork" run-diff panel (WorkflowRunDiff, rendered from Workflows.tsx)
// used to ignore useWorkflowRunState's `.error` for either side of the comparison. When
// GET /workflows/run/:runId failed for one run, `rows` stayed an empty array — which rendered
// EXACTLY like "both runs have identical output" (header showed "0 identical · 0 diverged", body
// showed the "No step output to compare" note). Since the whole point of a fork is to compare two
// runs, a fetch failure reading as "no differences" is actively misleading (an operator could
// conclude the fork changed nothing and discard it, or needlessly re-run a paid model call).
//
// Covers: when one side's run-state fetch fails, the panel shows ErrorBox instead of the
// "no steps to compare" note, and hides the (now-meaningless) diff counter.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Workflows } from '../src/views/Workflows';
import '../src/i18n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
    takeRecords() { return []; }
  });
  // WorkflowDetail renders @xyflow/react's <ReactFlow>, which needs ResizeObserver (not in jsdom).
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
});

/** Per-route status/body stub — the shared views.test.tsx helper only supports 200s, this test needs a 500. */
function stubFetch(routes: Record<string, { status?: number; body: unknown }>) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    const route = key ? routes[key] : { status: 200, body: [] };
    const status = route.status ?? 200;
    return {
      ok: status < 300,
      status,
      statusText: status < 300 ? 'OK' : 'Error',
      clone() { return this; },
      headers: { get: () => 'application/json' },
      json: async () => route.body,
    };
  }));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const CAPS = {
  resume: true, chat: false, fork: false, playground: true, stream: true, compensate: false,
  tools: false, toolExec: false, toolExecDurable: false, memory: false,
  workflows: true, workflowExec: true, scorers: false, datasets: false, mcp: false, a2a: false,
  queue: false, knowledge: false, workflowManage: false, workflowRunCancel: false,
};

const WORKFLOWS = [{ name: 'invoice', steps: [{ id: 's1', kind: 'step' }] }];

const RUN_A = 'wf-invoice-100';
const RUN_B = 'wf-invoice-200';

// This test's setup chains three mocked fetches (capabilities → workflows → the auto-selected
// workflow's runs) plus a run-state fetch on top before each async assertion below can resolve.
// Under an isolated run that settles well inside the default 1000ms @testing-library timeout, but
// full-suite runs (290 files, many parallel workers competing for CPU) can push the same chain past
// it without anything actually being broken — this widens only the load-sensitive waits, it does not
// change what they assert.
const LOAD_TIMEOUT = 5000;

describe('WorkflowRunDiff (via Workflows view) — STATE-08', () => {
  it('shows ErrorBox (not "no steps to compare") when one side of the diff fails to load, and hides the diff counter', async () => {
    stubFetch({
      '/capabilities': { body: CAPS },
      '/workflows': { body: WORKFLOWS },
      '/workflows/invoice/runs': {
        body: [
          { runId: RUN_A, startedAt: 100, steps: 1, status: 'completed', suspended: false },
          { runId: RUN_B, startedAt: 200, steps: 1, status: 'completed', suspended: false },
        ],
      },
      [`/workflows/run/${RUN_A}`]: { body: { runId: RUN_A, steps: [{ stepId: 's1', output: 'a' }], suspended: false } },
      // The failing side: server 500 with a JSON error body (same shape api.ts's http() parses).
      [`/workflows/run/${RUN_B}`]: { status: 500, body: { error: 'journal unavailable' } },
    });
    wrap(<Workflows />);

    // Open the history menu and pick RUN_A as the active run (sets lastRunId → onDiff becomes available).
    const historyBtn = await screen.findByText('History (2)', {}, { timeout: LOAD_TIMEOUT });
    fireEvent.click(historyBtn);
    fireEvent.click(await screen.findByText(RUN_A));

    // Reopen the history menu; the "compare with active run" icon only renders once lastRunId is set —
    // its appearance is the async-safe signal that RUN_A finished loading as the active run.
    fireEvent.click(await screen.findByText('History (2)', {}, { timeout: LOAD_TIMEOUT }));
    fireEvent.click(await screen.findByTitle('Compare with active run', {}, { timeout: LOAD_TIMEOUT }));

    // WorkflowRunDiff is now mounted with a=RUN_A (ok), b=RUN_B (500) — assert the error branch, not the
    // "identical / no steps" branch that STATE-08 used to fall into.
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy(), { timeout: LOAD_TIMEOUT });
    expect(screen.getByRole('alert').textContent).toContain('journal unavailable');
    expect(screen.queryByText('No step output to compare.')).toBeNull();
    expect(screen.queryByText(/identical/)).toBeNull();
    expect(screen.queryByText(/diverged/)).toBeNull();
  });
});
