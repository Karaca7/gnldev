// @vitest-environment jsdom
// Bug-investigation fix #1 (CRITICAL): on caps.isError, authRequired must not silently fall back to
// false and skip Login, showing a broken AppShell — instead a separate "unable to reach" + "Retry" screen.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import App from '../src/App';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
});

// api.ts's http() calls res.clone().json() on the `!res.ok` branch — the minimal mock must cover that too.
function failingFetch() {
  return vi.fn(async () => ({
    ok: false,
    status: 500,
    statusText: 'Internal Server Error',
    clone: () => ({ json: async () => { throw new Error('not json'); } }),
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

describe('App — caps.isError fail-open CRITICAL fix', () => {
  it('when capabilities cannot be fetched, shows the "unable to reach" screen, NOT AppShell/Login', async () => {
    vi.stubGlobal('fetch', failingFetch());
    wrap();
    await waitFor(() => expect(screen.getByText(/Unable to reach the server/)).toBeTruthy());
    // No Login form, no AppShell nav — an unknown authRequired must not fall through to a broken UI.
    expect(screen.queryByText('Sign in to Studio')).toBeNull();
    expect(screen.queryByText('Inspector')).toBeNull();
  });

  it('"Retry" refetches the capabilities query', async () => {
    const fetchMock = failingFetch();
    vi.stubGlobal('fetch', fetchMock);
    wrap();
    await waitFor(() => expect(screen.getByText(/Unable to reach the server/)).toBeTruthy());
    const callsBefore = fetchMock.mock.calls.length;
    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => expect(fetchMock.mock.calls.length).toBeGreaterThan(callsBefore));
  });
});
