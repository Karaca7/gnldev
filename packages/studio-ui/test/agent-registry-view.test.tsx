// @vitest-environment jsdom
// Scope: Agents.tsx agent APPROVAL registry surface (badge + Approve/Block buttons) — see
// AgentApprovalBadge/AgentApprovalControls in Agents.tsx and the `canSeeRegistry` gate that decides
// whether the (background-polled) GET /agents/registry query is even issued.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Agents } from '../src/views/Agents';

afterEach(() => { cleanup(); localStorage.clear(); });

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

function jsonOk(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
}
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const AGENTS = [{ name: 'a', model: 'openai/gpt-4o', hasTools: false, maxSteps: 6 }];
const ME_OPERATOR = { id: null, roles: [], orgId: null, operator: true, platformAdmin: false };

describe('Agents: approval registry — visible + actionable for an operator', () => {
  it('shows the status badge for each state and lets an operator approve/block', async () => {
    const calls: { url: string; method?: string; body?: string }[] = [];
    let registry = [
      { name: 'a', status: 'pending', fingerprint: 'f1', firstSeenAt: 1, updatedAt: 1 },
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method, body: init?.body as string | undefined });
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true, agentRegistry: true });
      if (u.endsWith('/agents')) return jsonOk(AGENTS);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: [] });
      if (u.endsWith('/me')) return jsonOk(ME_OPERATOR);
      if (u.endsWith('/agents/registry')) return jsonOk(registry);
      if (/\/agents\/registry\/a\/approve$/.test(u) && init?.method === 'POST') {
        registry = [{ ...registry[0], status: 'approved', approvedFingerprint: 'f1', approvedBy: 'op', approvedAt: 2, updatedAt: 2 }];
        return jsonOk({ ok: true, record: registry[0] });
      }
      return jsonOk([]);
    }));
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());

    // pending badge + an Approve button (no Block-hidden — block is offered too since status !== 'blocked')
    await waitFor(() => expect(screen.getByText('pending approval')).toBeTruthy());
    const approveBtn = screen.getByRole('button', { name: /Approve/ });
    fireEvent.click(approveBtn);

    // after approve, the badge flips to "approved" (query invalidation → refetch)
    await waitFor(() => expect(screen.getByText('approved')).toBeTruthy());
    expect(calls.some((c) => /\/agents\/registry\/a\/approve$/.test(c.url) && c.method === 'POST')).toBe(true);
  });

  it('a "changed" record shows the distinct "needs re-approval" badge', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true, agentRegistry: true });
      if (u.endsWith('/agents')) return jsonOk(AGENTS);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: [] });
      if (u.endsWith('/me')) return jsonOk(ME_OPERATOR);
      if (u.endsWith('/agents/registry')) {
        return jsonOk([{ name: 'a', status: 'changed', fingerprint: 'f2', approvedFingerprint: 'f1', firstSeenAt: 1, updatedAt: 2 }]);
      }
      return jsonOk([]);
    }));
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    await waitFor(() => expect(screen.getByText('needs re-approval')).toBeTruthy());
  });
});

describe('Agents: approval registry — hidden for a caller who cannot see it', () => {
  it('no agentRegistry capability → no badge, and GET /agents/registry is never called', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true }); // agentRegistry absent
      if (u.endsWith('/agents')) return jsonOk(AGENTS);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: [] });
      if (u.endsWith('/me')) return jsonOk(ME_OPERATOR);
      return jsonOk([]);
    }));
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    expect(screen.queryByText('pending approval')).toBeNull();
    expect(calls.some((u) => u.endsWith('/agents/registry'))).toBe(false);
  });

  it('an org-bound identity (would 403 server-side) → the registry query is never issued', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      calls.push(u);
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true, agentRegistry: true });
      if (u.endsWith('/agents')) return jsonOk(AGENTS);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: [] });
      if (u.endsWith('/me')) return jsonOk({ id: 'acme-adm', roles: ['admin'], orgId: 'acme', operator: false, platformAdmin: false });
      return jsonOk([]);
    }));
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('a')).toBeTruthy());
    expect(calls.some((u) => u.endsWith('/agents/registry'))).toBe(false);
  });
});
