// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n'; // Observability now uses useTranslation — needs to be initialized in the test too (test-side counterpart of the side effect in main.tsx).
import { Badge, cn } from '../src/components';
import { Inspector } from '../src/views/Inspector';
import { Observability } from '../src/views/Observability';
import { Approvals } from '../src/views/Approvals';
import { Organizations } from '../src/views/Organizations';
import { Playground } from '../src/views/Playground';
import { diffWorkflowSteps } from '../src/views/workflow-diff';

afterEach(() => {
  cleanup();
  localStorage.clear(); // don't let persistent selections like gnl-insp-run leak across tests
});

// recharts' ResponsiveContainer needs ResizeObserver; not present in jsdom → no-op stub.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

// Playground's smart auto-scroll calls scrollIntoView; jsdom doesn't implement it → no-op stub.
Element.prototype.scrollIntoView = vi.fn();

// framer-motion's Reveal (viewport) feature needs IntersectionObserver; not present in jsdom → no-op stub.
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

// api.ts's http() only uses res.ok / res.headers.get / res.json → a minimal mock is enough (not dependent on the Response global).
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

describe('studio-ui components', () => {
  it('cn + Badge render', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b');
    wrap(<Badge tone="success">ok</Badge>);
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('Inspector fetches and shows the API run list (paginated endpoint)', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-42', status: 'completed', modelSteps: 2, toolCalls: 1 }], total: 1 },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-42')).toBeTruthy());
    expect(screen.getByText(/2 model · 1 tool/)).toBeTruthy();
  });

  it('Inspector shows "No runs." for an empty list', async () => {
    stubFetch({ '/capabilities': CAPS, '/runs?limit=50': { items: [], total: 0 } });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('No runs.')).toBeTruthy());
  });

  it('Inspector purge: with caps.purge, trash button → confirmation dialog → DELETE /runs/:id', async () => {
    stubFetch({
      '/capabilities': { ...CAPS, purge: true },
      '/runs?limit=50': { items: [{ runId: 'run-42', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-42/cost': { totalTokens: 10, costUsd: 0.01 },
      '/runs/run-42/scores': { scores: {} },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-42')).toBeTruthy());
    fireEvent.click(screen.getByText('run-42')); // select the run → RunDetail opens
    const purgeBtn = await screen.findByTitle('Permanently delete this run (GDPR purge)');
    fireEvent.click(purgeBtn);
    fireEvent.click(await screen.findByText('Permanently delete')); // confirm the dialog
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const del = calls.find(([u, init]: any[]) => String(u).endsWith('/runs/run-42') && init?.method === 'DELETE');
      expect(del).toBeTruthy();
    });
  });

  it('Organizations retention panel: visible with caps.retention → confirm sweep → POST /retention/sweep + result badges', async () => {
    stubFetch({
      '/retention/sweep': { ok: true, scanned: 5, purged: ['a', 'b'], keptSuspended: 1, keptNoTs: 0, deletedEntries: 12 },
      '/capabilities': { ...CAPS, organizations: true, retention: true },
      '/organizations': { organizations: [] },
    });
    wrap(<Organizations />);
    await waitFor(() => expect(screen.getByText('Retention sweep')).toBeTruthy());
    fireEvent.click(screen.getByText('Sweep')); // panel button → dialog
    const confirm = (await screen.findAllByText('Sweep')).at(-1)!; // the confirm button in the dialog
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('2 deleted')).toBeTruthy());
    expect(screen.getByText('5 scanned')).toBeTruthy();
    expect(screen.getByText('1 kept suspended')).toBeTruthy();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const post = calls.find(([u, init]: any[]) => String(u).endsWith('/retention/sweep') && init?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse((post![1] as any).body).olderThanMs).toBe(30 * 86_400_000);
  });

  it('Inspector pagination: with a nextCursor, "load more" appends the next page', async () => {
    stubFetch({
      // endsWith match: the cursor'd URL only hits the cursor'd key, no collision.
      '/runs?limit=50&cursor=50': { items: [{ runId: 'run-old', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 2 },
      '/runs?limit=50': { items: [{ runId: 'run-new', status: 'completed', modelSteps: 1, toolCalls: 0 }], nextCursor: '50', total: 2 },
      '/capabilities': CAPS,
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-new')).toBeTruthy());
    const more = screen.getByText(/load more \(1\/2\)/);
    fireEvent.click(more.closest('button')!);
    await waitFor(() => expect(screen.getByText('run-old')).toBeTruthy());
    expect(screen.queryByText(/load more/)).toBeNull(); // last page → button disappears
  });

  it('Observability: renders cards + p95 + the rich run table', async () => {
    // Note: the '/metrics/runs' key must come BEFORE '/runs' (stubFetch's endsWith takes the first match).
    stubFetch({
      '/metrics/runs': {
        runs: [
          { runId: 'obs-1', status: 'completed', modelSteps: 2, toolCalls: 1, startTs: 1_700_000_000_000, durationMs: 850, costUsd: 0.0123, totalTokens: 420 },
          { runId: 'obs-2', status: 'suspended', modelSteps: 1, toolCalls: 0, startTs: 1_700_000_100_000, durationMs: 1900, costUsd: 0.002, totalTokens: 80 },
        ],
      },
      '/metrics': { total: 2, byStatus: { completed: 1, suspended: 1 }, costUsd: 0.0143, tokens: 500 },
      '/capabilities': CAPS,
      '/runs': [],
    });
    wrap(<Observability />);
    await waitFor(() => expect(screen.getByText('obs-1')).toBeTruthy());
    expect(screen.getByText('Duration p95')).toBeTruthy();
    expect(screen.getAllByText('1.9s').length).toBeGreaterThanOrEqual(2); // p95 card + table row (1900ms)
    expect(screen.getByText('850ms')).toBeTruthy(); // table duration column
    expect(screen.getByText('$0.0123')).toBeTruthy(); // table cost column
  });

  it('diffWorkflowSteps: aligns matching/diverging/one-sided steps', () => {
    const a = [
      { stepId: 'validate', output: { ok: true } },
      { stepId: 'aggregate', output: { items: 3 } },
      { stepId: 'approve', output: { approved: true } },
    ];
    const b = [
      { stepId: 'validate', output: { ok: true } }, // replay — same
      { stepId: 'aggregate', output: { items: 5 } }, // diverges
      { stepId: 'notify', output: { sent: true } }, // B only
    ];
    const rows = diffWorkflowSteps(a, b);
    expect(rows.map((r) => [r.stepId, r.equal])).toEqual([
      ['validate', true],
      ['aggregate', false],
      ['approve', false], // A only → diverges
      ['notify', false], // B only, appended at the end
    ]);
    expect(rows[2].b).toBeUndefined();
    expect(rows[3].a).toBeUndefined();
  });

  it('Playground: switching agents clears the loaded thread (no leftover conversation from the previous agent)', async () => {
    stubFetch({
      '/capabilities': { ...CAPS, playground: true, memory: true },
      '/agents': [
        { name: 'alpha', model: 'm', hasTools: false },
        { name: 'beta', model: 'm', hasTools: false },
      ],
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      '/threads?resourceId=studio-user': [{ id: 't-1', title: 'Old chat', resourceId: 'studio-user', createdAt: 1, updatedAt: 1 }],
      '/threads/t-1/messages': [{ role: 'user', content: 'message from the old thread' }],
    });
    wrap(<Playground />);
    // Pick the past conversation → its history is restored into the chat pane.
    fireEvent.click(await screen.findByText('Old chat'));
    await waitFor(() => expect(screen.getByText('message from the old thread')).toBeTruthy());
    // Switch agents → the previous agent's conversation must NOT linger.
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'beta' } });
    await waitFor(() => expect(screen.queryByText('message from the old thread')).toBeNull());
  });

  it('Approvals: lists the pending approval, Approve/Deny buttons are visible', async () => {
    stubFetch({
      '/approvals': { items: [{ runId: 'sus-1', toolCallId: 'call-1', toolName: 'chargeCard', args: { amount: 99 }, reason: 'high amount' }] },
      '/capabilities': CAPS,
    });
    wrap(<Approvals />);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
    expect(screen.getByText(/high amount/)).toBeTruthy();
  });
});
