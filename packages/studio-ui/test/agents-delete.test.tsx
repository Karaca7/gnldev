// @vitest-environment jsdom
// Scope: Agents.tsx managed agent DELETE flow (DELETE /managed-agents/:name).
// User couldn't clean up trial agents (e.g. "dd") they created — a DELETE endpoint was added to
// server.ts + store.delete; this verifies the UI side: Trash2 → ConfirmDialog (code-vs-managed text
// differs) → confirm → DELETE request goes out → ['managed-agents'] is invalidated → the card updates.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n'; // EN default language — so Agents' t() calls use the real translation.
import { Agents } from '../src/views/Agents';

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

function jsonOk(body: unknown) {
  return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('Agents: managed agent delete (DELETE /managed-agents/:name)', () => {
  it('managed-only agent (no code counterpart): Delete → "disappears entirely" confirmation → DELETE goes out → card is removed', async () => {
    let managedAgents: any[] = [{ name: 'dd', active: null, versions: [{ version: 1, model: 'anthropic/claude-sonnet-5', createdAt: 1 }] }];
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, method: init?.method });
      if (u.endsWith('/managed-agents/dd') && init?.method === 'DELETE') {
        managedAgents = [];
        return jsonOk({ ok: true, name: 'dd' });
      }
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true });
      if (u.endsWith('/agents')) return jsonOk([]);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: managedAgents });
      return jsonOk([]);
    }));

    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('dd')).toBeTruthy());

    // Trash2 button on the "managed-only" card (title carries the no-code-counterpart text).
    fireEvent.click(screen.getByTitle(/no code-defined counterpart/));

    // Confirmation dialog: for managed-only, "disappears entirely" text (no code-defined fallback).
    await waitFor(() => expect(screen.getByText(/disappears entirely/)).toBeTruthy());
    fireEvent.click(screen.getByText('Delete').closest('button')!);

    await waitFor(() => expect(screen.queryByText('dd')).toBeNull());

    const del = calls.find((c) => c.url.endsWith('/managed-agents/dd') && c.method === 'DELETE');
    expect(del).toBeTruthy();
  });

  it('code+managed agent: confirmation text states the code-defined agent WILL REMAIN; after deletion the managed badge is gone, the code agent card stays', async () => {
    let managedAgents: any[] = [{ name: 'yazar', active: 1, versions: [{ version: 1, model: 'anthropic/claude-sonnet-5', createdAt: 1 }] }];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith('/managed-agents/yazar') && init?.method === 'DELETE') {
        managedAgents = [];
        return jsonOk({ ok: true, name: 'yazar' });
      }
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true });
      if (u.endsWith('/agents')) return jsonOk([{ name: 'yazar', model: 'anthropic/claude-sonnet-5', hasTools: false }]);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: managedAgents });
      return jsonOk([]);
    }));

    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('managed v1 active')).toBeTruthy());

    fireEvent.click(screen.getByTitle(/code-defined agent stays/));

    // Confirmation dialog: for code+managed, "registry is unaffected" text.
    await waitFor(() => expect(screen.getByText(/code-defined agent \(registry\) is unaffected/)).toBeTruthy());
    fireEvent.click(screen.getByText('Delete').closest('button')!);

    // Managed badge is gone but the (code-defined) agent card stays.
    await waitFor(() => expect(screen.queryByText('managed v1 active')).toBeNull());
    expect(screen.getByText('yazar')).toBeTruthy();
  });
});
