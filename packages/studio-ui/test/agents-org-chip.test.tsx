// @vitest-environment jsdom
// Scope: Agents.tsx code-defined agent cards render an `org · <id>` chip for org-scoped agents
// (AgentMeta.orgs) — consistent with the Inspector org badge; global agents (no orgs) show no chip.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
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

const AGENTS = [
  { name: 'scoped', model: 'openai/gpt-4o', hasTools: false, maxSteps: 6, orgs: ['acme'] },
  { name: 'global', model: 'openai/gpt-4o', hasTools: false, maxSteps: 6 },
];

describe('Agents: org-scoped chip', () => {
  it('org-scoped agent shows an `org · acme` chip; global agent shows none', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true });
      if (u.endsWith('/agents')) return jsonOk(AGENTS);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: [] });
      return jsonOk([]);
    }));
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('scoped')).toBeTruthy());

    // The org chip is rendered for the org-scoped agent (i18n: "org · {{org}}").
    expect(screen.getByText('org · acme')).toBeTruthy();
    // Exactly one chip → the global agent has none.
    expect(screen.getAllByText(/^org · /)).toHaveLength(1);
  });
});
