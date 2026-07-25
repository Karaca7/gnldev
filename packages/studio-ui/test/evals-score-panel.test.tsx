// @vitest-environment jsdom
// STATE-09 + FORM-10 regression: `/capabilities` resolves near-instantly (fetched once on app boot,
// cached), while `/scorers` starts fetching only once Evals mounts — so ScoreRunPanel used to mount
// with `scorerNames: []`, seed its checkbox Set from that empty list via `useState`'s initializer
// (which only ever runs on the FIRST render), and stay permanently empty once the real scorer names
// arrived. Covers: (1) Evals waits for scorers/datasets to load before mounting the panel, so the
// checkboxes come in pre-checked; (2) ScoreRunPanel's reseed effect still re-syncs a late/changed
// scorer list as long as the user hasn't touched a checkbox yet; (3) a manual toggle is never
// clobbered by a later reseed; (4) "Score" is disabled (with a hint) whenever no scorer is selected;
// (5) a `/runs` fetch error renders ErrorBox instead of silently offering an empty run dropdown.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Evals, ScoreRunPanel } from '../src/views/Evals';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

/** Like the plain endsWith fetch stub used elsewhere in this suite, but a subset of paths can be
 *  answered from a caller-supplied (still-pending) Promise instead of resolving immediately — used to
 *  reproduce the capabilities-vs-scorers race deterministically instead of relying on real timing. */
function mockFetch(routes: Record<string, unknown>, delayed: Record<string, Promise<unknown>> = {}) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const delayedKey = Object.keys(delayed).find((k) => u.endsWith(k));
    const data = delayedKey ? await delayed[delayedKey] : (() => {
      const key = Object.keys(routes).find((k) => u.endsWith(k));
      return key ? routes[key] : [];
    })();
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => data };
  }));
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const CAPS = { scorers: true, datasets: false };

describe('Evals: scorers arriving after capabilities (mount-race)', () => {
  it('waits for /scorers before mounting the panel, so checkboxes come in pre-checked (not stuck empty)', async () => {
    const scorersDeferred = deferred<string[]>();
    mockFetch(
      { '/capabilities': CAPS, '/datasets': [], '/runs': [] },
      { '/scorers': scorersDeferred.promise },
    );
    wrap(<Evals />);

    // Capabilities has already resolved (scorers:true → not the "disabled" empty state) but /scorers
    // is still in flight — the view must show the loading indicator, not mount the panel with [].
    await waitFor(() => expect(screen.getByText('Loading…')).toBeTruthy());
    expect(screen.queryByText('Score a run')).toBeNull();

    scorersDeferred.resolve(['exact-match', 'toxicity']);

    await waitFor(() => expect(screen.getByLabelText('exact-match')).toBeTruthy());
    expect((screen.getByLabelText('exact-match') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('toxicity') as HTMLInputElement).checked).toBe(true);
  });
});

describe('ScoreRunPanel: reseed vs. user-touched selection', () => {
  it('a late-arriving scorer list auto-checks its boxes when the user has not touched any checkbox yet', async () => {
    mockFetch({ '/runs': [{ runId: 'r1', status: 'completed', modelSteps: 1, toolCalls: 0 }] });
    const { rerender } = render(
      <MemoryRouter><QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <ScoreRunPanel scorerNames={[]} />
      </QueryClientProvider></MemoryRouter>,
    );
    expect(screen.queryByLabelText('exact-match')).toBeNull();

    // Simulate the parent's scorers query resolving after mount.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rerender(
      <MemoryRouter><QueryClientProvider client={qc}>
        <ScoreRunPanel scorerNames={['exact-match', 'toxicity']} />
      </QueryClientProvider></MemoryRouter>,
    );
    await waitFor(() => expect((screen.getByLabelText('exact-match') as HTMLInputElement).checked).toBe(true));
    expect((screen.getByLabelText('toxicity') as HTMLInputElement).checked).toBe(true);
  });

  it('once the user unchecks a box, a subsequent scorer-list change does not clobber their selection', async () => {
    mockFetch({ '/runs': [] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { rerender } = render(
      <MemoryRouter><QueryClientProvider client={qc}>
        <ScoreRunPanel scorerNames={['exact-match', 'toxicity']} />
      </QueryClientProvider></MemoryRouter>,
    );
    await waitFor(() => expect((screen.getByLabelText('exact-match') as HTMLInputElement).checked).toBe(true));

    screen.getByLabelText('exact-match').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => expect((screen.getByLabelText('exact-match') as HTMLInputElement).checked).toBe(false));
    expect((screen.getByLabelText('toxicity') as HTMLInputElement).checked).toBe(true);

    // Scorer list changes again (e.g. a refetch adds a scorer) — the untouched-vs-customized rule must
    // NOT re-seed and silently re-check 'exact-match'.
    rerender(
      <MemoryRouter><QueryClientProvider client={qc}>
        <ScoreRunPanel scorerNames={['exact-match', 'toxicity', 'bleu']} />
      </QueryClientProvider></MemoryRouter>,
    );
    expect((screen.getByLabelText('exact-match') as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText('toxicity') as HTMLInputElement).checked).toBe(true);
  });

  it('"Score" is disabled with a hint when no scorer is selected, even with a run chosen', async () => {
    mockFetch({ '/runs': [{ runId: 'r1', status: 'completed', modelSteps: 1, toolCalls: 0 }] });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter><QueryClientProvider client={qc}>
        <ScoreRunPanel scorerNames={['exact-match']} />
      </QueryClientProvider></MemoryRouter>,
    );
    await waitFor(() => expect((screen.getByLabelText('exact-match') as HTMLInputElement).checked).toBe(true));

    screen.getByLabelText('exact-match').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    await waitFor(() => expect((screen.getByLabelText('exact-match') as HTMLInputElement).checked).toBe(false));

    const btn = screen.getByText('Score').closest('button')!;
    expect(btn.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('select at least one scorer')).toBeTruthy();
  });

  it('a /runs fetch error renders ErrorBox instead of an empty run dropdown', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: false, status: 500, headers: { get: () => 'application/json' }, json: async () => ({ error: 'boom' }),
    })));
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <MemoryRouter><QueryClientProvider client={qc}>
        <ScoreRunPanel scorerNames={['exact-match']} />
      </QueryClientProvider></MemoryRouter>,
    );
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByLabelText('run')).toBeNull();
  });
});
