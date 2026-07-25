// FORM-09 regression: field validation errors (org id format, budget limit sign) render INLINE
// (aria-invalid + message next to the offending input) instead of a toast in the opposite screen
// corner. Kept as its own file per instructions — do NOT add to the shared views.test.tsx.
// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n'; // Organizations reads via useTranslation('organizations') — needs global i18next init in tests too.
import { Organizations } from '../src/views/Organizations';

const { toastMock } = vi.hoisted(() => {
  const fn = vi.fn() as unknown as { (msg: string): void; error: ReturnType<typeof vi.fn>; success: ReturnType<typeof vi.fn> };
  (fn as any).error = vi.fn();
  (fn as any).success = vi.fn();
  return { toastMock: fn };
});
vi.mock('../src/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui')>();
  return { ...actual, toast: toastMock };
});

afterEach(() => cleanup());
beforeEach(() => {
  toastMock.mockClear();
  toastMock.error.mockClear();
  toastMock.success.mockClear();
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
  organizations: true, orgManage: true, budgetManage: true,
};

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('Organizations field-level validation (FORM-09)', () => {
  it('invalid org id: inline error + aria-invalid on the id input, NO toast', async () => {
    stubFetch({ '/capabilities': CAPS, '/organizations': { organizations: [] } });
    wrap(<Organizations />);
    await waitFor(() => expect(screen.getByText('New organization')).toBeTruthy());

    const idInput = screen.getByPlaceholderText('id (e.g. acme)') as HTMLInputElement;
    fireEvent.change(idInput, { target: { value: 'Acme Corp' } }); // uppercase + space → invalid chars
    fireEvent.click(screen.getByText('Add'));

    // Inline message next to the input, not a toast.
    await waitFor(() => expect(screen.getByText(/may only contain lowercase letters/i)).toBeTruthy());
    expect(idInput.getAttribute('aria-invalid')).toBe('true');
    expect(toastMock.error).not.toHaveBeenCalled();

    // Fixing the value clears the inline error right away.
    fireEvent.change(idInput, { target: { value: 'acme-corp' } });
    expect(screen.queryByText(/may only contain lowercase letters/i)).toBeNull();
    expect(idInput.getAttribute('aria-invalid')).toBe('false');
  });

  it('negative budget limit: inline error + aria-invalid on the USD input, NO toast', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/organizations': { organizations: [{ id: 'acme', runs: 0, tokens: 0, costUsd: 0, budget: null }] },
    });
    wrap(<Organizations />);
    await waitFor(() => expect(screen.getByText('acme')).toBeTruthy());

    fireEvent.click(screen.getByTitle('Edit budget'));
    const usdLabel = await screen.findByText('USD');
    const usdInput = usdLabel.closest('label')!.querySelector('input') as HTMLInputElement;
    fireEvent.change(usdInput, { target: { value: '-5' } });
    fireEvent.click(screen.getByText('Save'));

    await waitFor(() => expect(screen.getByText('Limits must be non-negative numbers')).toBeTruthy());
    expect(usdInput.getAttribute('aria-invalid')).toBe('true');
    expect(toastMock.error).not.toHaveBeenCalled();

    fireEvent.change(usdInput, { target: { value: '5' } });
    expect(screen.queryByText('Limits must be non-negative numbers')).toBeNull();
    expect(usdInput.getAttribute('aria-invalid')).toBe('false');
  });
});
