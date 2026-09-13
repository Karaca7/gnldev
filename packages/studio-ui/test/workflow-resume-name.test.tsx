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

  // PACKAGE #4: an engine-derived runId is a hash — there is nothing in it to parse, and the honest
  // answer is null rather than a lucky substring. The name comes from the RECORD now (the server
  // reads `:input.workflow` into `item.workflowName`), which the test below exercises.
  it('an engine-derived runId yields nothing, with or without a `#` suffix', () => {
    const derived = `run1_${'a'.repeat(32)}`;
    for (const id of [derived, `${derived}#2`, `${derived}#fork-1`, `${derived}#replay-0`]) {
      expect(deriveWorkflowName(id, ['invoice', 'order-fulfillment']), id).toBeNull();
    }
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
      // API-03: useWorkflowRunsRegistry now always sends `limit` (default 50) → the paged envelope.
      '/workflows/runs?status=suspended&limit=50': {
        items: [
          { runId: 'wf-invoice-1721900000000', workflowName: 'invoice', status: 'suspended', stepId: 'review', waitId: 'approval', updatedAt: 1721900000000 },
        ],
      },
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

  // PACKAGE #4: the derived-id row is the one that used to arrive nameless. Its runId says nothing,
  // so BOTH readable things on it now come from the record the server passes through — the workflow
  // name (`:input.workflow`) and the operator's own name for the job (`workKey`).
  it('a derived runId row still names its workflow, and shows the workKey next to the hash', async () => {
    const derived = `run1_${'b'.repeat(32)}#2`;
    stubFetch({
      '/capabilities': CAPS,
      '/workflows': WORKFLOWS,
      '/workflows/runs?status=suspended&limit=50': {
        items: [
          { runId: derived, workflowName: 'order-fulfillment', workKey: 'nightly-reconciliation', status: 'suspended', stepId: 'review', waitId: 'approval', updatedAt: 1721900000000 },
        ],
      },
    });
    wrap(<Workflows />);

    await waitFor(() => expect(screen.getByText('Suspended runs')).toBeTruthy());
    fireEvent.click(screen.getByText('Suspended runs'));
    await waitFor(() => expect(screen.getByText(derived)).toBeTruthy());
    expect(screen.getByText(/nightly-reconciliation/)).toBeTruthy();

    fireEvent.click(screen.getByText('Resume'));
    const select = (await screen.findByLabelText('Workflow')) as HTMLSelectElement;
    expect(select.value).toBe('order-fulfillment');
    expect(screen.getByText('from server')).toBeTruthy(); // recorded, never guessed from the hash
  });
});
