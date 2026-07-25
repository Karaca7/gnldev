// @vitest-environment jsdom
// A11Y-08 (WCAG 2.4.1 Bypass Blocks): a keyboard user must be able to jump past the sidebar
// (~19 nav items + Swagger/lang/theme/logout) straight to <main> instead of tabbing through all
// of it on every page load. Pins the skip-link's presence, href target, and that <main id="main">
// actually exists to be jumped to.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

// api.ts's http() only needs res.ok / res.headers.get / res.json — a minimal mock is enough.
// authRequired is omitted (falsy) so App renders AppShell directly, no Login screen in the way.
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

function wrap() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter>
      <QueryClientProvider client={qc}>
        <App />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe('App — skip-to-content link (A11Y-08)', () => {
  it('renders a skip link pointing at #main, and <main id="main"> exists as its target', async () => {
    stubFetch({
      '/capabilities': {},
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      '/runs?limit=50': { items: [], total: 0 },
    });
    const { container } = wrap();
    await waitFor(() => expect(screen.getByText('Inspector')).toBeTruthy()); // AppShell/sidebar rendered

    const skipLink = screen.getByText('Skip to content');
    expect(skipLink.tagName).toBe('A');
    expect(skipLink.getAttribute('href')).toBe('#main');
    expect(skipLink.className).toContain('sr-only'); // hidden until focused

    const main = container.querySelector('#main');
    expect(main).toBeTruthy();
    expect(main!.tagName).toBe('MAIN');
    expect(main!.getAttribute('tabindex')).toBe('-1'); // programmatically focusable as the jump target
  });
});
