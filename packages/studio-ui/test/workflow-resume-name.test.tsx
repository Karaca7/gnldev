// @vitest-environment jsdom
// FLOW-08: resuming a suspended workflow run used to force the operator to GUESS the workflow name
// from a flat dropdown (WorkflowRunRegistryItem never carried it). Covers:
//  (a) deriveWorkflowName (pure): the runId → name fallback when the server hasn't stamped
//      `workflowName` yet (older registry records).
//  (b) SuspendedRunsInbox (via the exported Workflows view): when `workflowName` IS present on the
//      registry item, the resume form pre-fills from it (authoritative, not a guess).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Workflows, deriveWorkflowName } from '../src/views/Workflows';
import '../src/i18n';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// Re-stubbed in beforeEach (not just once at module scope) since afterEach's unstubAllGlobals()
// would otherwise wipe these out again after the first test that needs them.
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

describe('deriveWorkflowName (pure)', () => {
  it('resolves a hyphenated workflow name from the runId (wf-<name>-<ts> convention)', () => {
    expect(deriveWorkflowName('wf-order-fulfillment-1721900000000', ['order-fulfillment'])).toBe('order-fulfillment');
  });

  it('when two known names share a prefix, the LONGEST matching name wins (not a naive split)', () => {
    expect(deriveWorkflowName('wf-order-fulfillment-1721900000000', ['order', 'order-fulfillment'])).toBe('order-fulfillment');
    // order of knownNames shouldn't matter
    expect(deriveWorkflowName('wf-order-fulfillment-1721900000000', ['order-fulfillment', 'order'])).toBe('order-fulfillment');
  });

  it('no known name matches the runId → null (caller falls back to letting the user pick)', () => {
    expect(deriveWorkflowName('wf-unknown-1721900000000', ['invoice', 'order'])).toBeNull();
  });

  it('rejects a match without an all-digit timestamp suffix (avoids a false-positive prefix match)', () => {
    expect(deriveWorkflowName('wf-invoice-not-a-timestamp', ['invoice'])).toBeNull();
  });

  it('also matches the dry-run runId variant (dry-wf-<name>-<ts>, see runStepwise)', () => {
    expect(deriveWorkflowName('dry-wf-invoice-1721900000000', ['invoice'])).toBe('invoice');
  });
});

const CAPS = {
  resume: true, chat: false, fork: false, playground: true, stream: true, compensate: false,
  tools: false, toolExec: false, toolExecDurable: false, memory: false,
  workflows: true, workflowExec: true, scorers: false, datasets: false, mcp: false, a2a: false,
  queue: false, knowledge: false, workflowManage: false, workflowRunCancel: true,
};

const WORKFLOWS = [
  { name: 'invoice', steps: [{ id: 's1', kind: 'step' }] },
  { name: 'order-fulfillment', steps: [{ id: 's1', kind: 'step' }] },
];

describe('SuspendedRunsInbox resume form (via Workflows view)', () => {
  it('pre-fills the workflow select from item.workflowName (server-confirmed, no guessing needed)', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/workflows': WORKFLOWS,
      '/workflows/runs?status=suspended': [
        { runId: 'wf-invoice-1721900000000', workflowName: 'invoice', status: 'suspended', stepId: 'review', waitId: 'approval', updatedAt: 1721900000000 },
      ],
    });
    wrap(<Workflows />);

    // Open the suspended-runs inbox.
    await waitFor(() => expect(screen.getByText('Suspended runs')).toBeTruthy());
    fireEvent.click(screen.getByText('Suspended runs'));
    await waitFor(() => expect(screen.getByText('wf-invoice-1721900000000')).toBeTruthy());

    // Expand the resume form.
    fireEvent.click(screen.getByText('Resume'));

    // The dropdown is pre-filled with the server-supplied name, and it's flagged as authoritative
    // (not a guess) — the operator can still change it (native <select>, not disabled).
    const select = (await screen.findByLabelText('Workflow')) as HTMLSelectElement;
    expect(select.value).toBe('invoice');
    expect(select.disabled).toBe(false);
    expect(screen.getByText('from server')).toBeTruthy();
  });
});
