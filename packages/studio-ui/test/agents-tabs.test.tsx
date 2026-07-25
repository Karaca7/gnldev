// @vitest-environment jsdom
// Scope: Agents.tsx tab split — 'list' (cards) / 'create' (create-edit form).
// The "+version" form from a card opens pre-filled with that agent's name (Edit · <name>).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n'; // Agents now uses useTranslation — needs to be initialized in the test too (same pattern as views.test.tsx).
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
function stub(managed: any[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true });
    // 'dd' is CODE-defined (managed versions govern code agents — Option A: no orphan builder).
    if (u.endsWith('/agents')) return jsonOk([{ name: 'dd', model: 'openai/gpt-4o', hasTools: false, maxSteps: 4 }]);
    if (u.endsWith('/managed-agents')) return jsonOk({ agents: managed });
    return jsonOk([]);
  }));
}
const DD = [{ name: 'dd', active: 1, versions: [{ version: 1, model: 'openai/gpt-4o', createdAt: 1 }] }];
const DD2 = [{ name: 'dd', active: 1, versions: [
  { version: 1, model: 'openai/gpt-4o', system: 'v1 sys', createdAt: 1 },
  { version: 2, model: 'anthropic/claude-sonnet-5', system: 'v2 sys', note: 'v2 note', createdAt: 2 },
] }];

describe('Agents: tab split (cards / create-edit)', () => {
  it('two tabs; the default shows list cards, form is hidden; the "Create" tab opens the form', async () => {
    stub(DD);
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('dd')).toBeTruthy());

    // A11Y-06: these are real ARIA tabs (role="tab" + aria-selected on a role="tablist" wrapper).
    expect(screen.getByRole('tab', { name: /Agents/ })).toBeTruthy();
    const createTab = screen.getByRole('tab', { name: 'New version' }); // versions a code agent (renamed from "Create / Edit")

    // Form is HIDDEN on the default (list) tab (the model input's placeholder is unique to the form)
    expect(screen.queryByPlaceholderText('openai/gpt-4o-mini')).toBeNull();

    // Switch to the New-version tab → form appears (model input + code-agent select)
    fireEvent.click(createTab);
    await waitFor(() => expect(screen.getByPlaceholderText('openai/gpt-4o-mini')).toBeTruthy());
  });

  it('"edit" from a card → the create tab opens pre-filled with the current version (Edit · dd)', async () => {
    stub(DD);
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('dd')).toBeTruthy());

    fireEvent.click(screen.getByTitle(/Edit — loads the current version into the form/));

    // The model (from the current version) is pre-filled → a real edit. The name is PINNED to the code
    // agent (shown read-only, not a free-text field → Option A: versions govern code agents).
    await waitFor(() => expect(screen.getByDisplayValue('openai/gpt-4o')).toBeTruthy());
    expect(screen.getByRole('tab', { name: /Edit · dd/ })).toBeTruthy();
  });
});

describe('Agents: per-version edit / delete', () => {
  it('"edit" on a version row loads THAT version\'s model into the form (v2)', async () => {
    stub(DD2);
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('dd')).toBeTruthy());

    // Version-row edit buttons (newest=v2 first). The card-level edit carries a different title.
    fireEvent.click(screen.getAllByTitle(/Edit based on this version/)[0]);

    await waitFor(() => expect(screen.getByDisplayValue('anthropic/claude-sonnet-5')).toBeTruthy());
    expect(screen.getByDisplayValue('v2 note')).toBeTruthy();      // the note field is also pre-filled from that version
    expect(screen.getByDisplayValue('v2 sys')).toBeTruthy();       // as is the system prompt
  });

  it('a NON-active version can be deleted (confirm → DELETE .../versions/2); the active version has NO delete button', async () => {
    const calls: { url: string; method?: string }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url); calls.push({ url: u, method: init?.method });
      if (/\/managed-agents\/dd\/versions\/2$/.test(u) && init?.method === 'DELETE') return jsonOk({ ok: true, name: 'dd', version: 2, active: 1, remaining: 1 });
      if (u.endsWith('/capabilities')) return jsonOk({ agentVersions: true });
      if (u.endsWith('/agents')) return jsonOk([]);
      if (u.endsWith('/managed-agents')) return jsonOk({ agents: DD2 });
      return jsonOk([]);
    }));
    wrap(<Agents />);
    await waitFor(() => expect(screen.getByText('dd')).toBeTruthy());

    // Only v2 (not active) carries a delete button → single match (v1 is active → none)
    const delBtns = screen.getAllByTitle(/Delete this version/);
    expect(delBtns).toHaveLength(1);
    fireEvent.click(delBtns[0]);

    await waitFor(() => expect(screen.getByText('Delete version')).toBeTruthy());
    fireEvent.click(screen.getByText('Delete').closest('button')!);

    await waitFor(() => expect(calls.find((c) => /\/versions\/2$/.test(c.url) && c.method === 'DELETE')).toBeTruthy());
  });
});
