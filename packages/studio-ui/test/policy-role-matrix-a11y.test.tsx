// @vitest-environment jsdom
// [A11Y-12] Policy's role→permission matrix: the "not granted" cell used to be a '–' at
// text-muted-foreground/40 opacity (~1.8:1, fails WCAG 1.4.3) with no non-color signal (fails
// 1.4.1) and no accessible name (decorative glyph only). This covers: opacity class is gone,
// the glyph pair is distinct (✓ vs ✕) rather than opacity-only, and both states expose an
// accessible name via sr-only text for screen readers.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Policy } from '../src/views/Policy';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function route(pathSuffix: string, json: unknown) {
  return { match: (u: string) => u.endsWith(pathSuffix), json };
}
function mockFetch(handlers: ReturnType<typeof route>[]) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const found = handlers.find((h) => h.match(String(url)));
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => (found ? found.json : []),
    };
  }));
}
function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const CATALOG = {
  enabled: true,
  permissions: [
    { id: 'agents:run', label: 'Run agents', group: 'run' },
    { id: 'users:write', label: 'Manage users', group: 'admin' },
  ],
  rolePresets: {
    viewer: [],
    admin: ['agents:run', 'users:write'],
  },
};

describe('Policy: role matrix "not granted" cell accessibility (A11Y-12)', () => {
  it('renders a distinct glyph (not opacity-only) with accessible names for both granted and not-granted cells', async () => {
    mockFetch([
      route('/capabilities', { policy: true }),
      route('/permissions/catalog', CATALOG),
      route('/policy', { policy: { version: 1, rules: [] } }),
    ]);
    wrap(<Policy />);
    await waitFor(() => expect(screen.getByText('agents:run')).toBeTruthy());

    // viewer grants nothing → 'agents:run' row, viewer column is "not granted".
    const notGrantedLabels = screen.getAllByText('Not granted', { selector: '.sr-only' });
    expect(notGrantedLabels.length).toBeGreaterThan(0);
    // admin grants both → at least one "Granted" accessible label.
    const grantedLabels = screen.getAllByText('Granted', { selector: '.sr-only' });
    expect(grantedLabels.length).toBeGreaterThan(0);

    // The glyph pair must be distinct (✕ for not-granted), not just an opacity-dimmed '–'.
    expect(screen.getAllByText('✕').length).toBeGreaterThan(0);
    expect(screen.getAllByText('✓').length).toBeGreaterThan(0);
    expect(screen.queryByText('–')).toBeNull();

    // No leftover /40 low-opacity styling on the "not granted" glyph.
    const notGrantedGlyph = screen.getAllByText('✕')[0];
    expect(notGrantedGlyph.className).not.toMatch(/\/40/);
    expect(notGrantedGlyph.className).toContain('text-muted-foreground');
    // Decorative glyph is hidden from assistive tech; the sr-only sibling carries the name instead.
    expect(notGrantedGlyph.getAttribute('aria-hidden')).toBe('true');
  });
});
