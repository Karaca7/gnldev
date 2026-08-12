// @vitest-environment jsdom
// Jobs view: the queue table was rendered by nothing in the test suite (0% coverage), so its two
// gates were unverified — (1) the retry column only exists when caps.queueManage is on, (2) only
// `failed` rows get a retry button, and a click locks the WHOLE panel so a second click can't open
// a second new job. Status counters are asserted through the data, not through i18n labels.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Jobs } from '../src/views/Jobs';

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
vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });

const JOBS = [
  { id: 'job-ok', type: 'send-email', status: 'done', attempts: 1 },
  { id: 'job-dead', type: 'reindex', status: 'failed', attempts: 3 },
  { id: 'job-wait', type: 'sweep', status: 'queued', attempts: 0 },
];

/** Records every request so the retry POST can be asserted (path + method). */
function stubFetch(opts: { jobs?: unknown; queueManage?: boolean; onRetry?: () => unknown } = {}) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET' });
    let body: unknown = [];
    if (u.includes('/capabilities')) body = { queueManage: opts.queueManage ?? false };
    else if (/\/jobs\/[^/]+\/retry$/.test(u)) body = opts.onRetry ? opts.onRetry() : { ok: true, id: 'job-dead' };
    else if (u.endsWith('/jobs')) body = opts.jobs ?? JOBS;
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  }));
  return calls;
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('Jobs view', () => {
  it('renders one row per job with id, type, status and attempts', async () => {
    stubFetch();
    wrap(<Jobs />);
    await waitFor(() => expect(screen.getByText('job-ok')).toBeTruthy());
    for (const j of JOBS) {
      expect(screen.getByText(j.id)).toBeTruthy();
      expect(screen.getByText(j.type)).toBeTruthy();
    }
    // statuses are double-coded: a text Badge next to a decorative glyph
    expect(screen.getByText('done')).toBeTruthy();
    expect(screen.getByText('failed')).toBeTruthy();
    expect(screen.getByText('queued')).toBeTruthy();
  });

  it('shows the empty state when the queue has no jobs', async () => {
    stubFetch({ jobs: [] });
    wrap(<Jobs />);
    await waitFor(() => expect(screen.queryByText('job-ok')).toBeNull());
    expect(screen.queryByRole('table')).toBeNull();
  });

  it('without caps.queueManage there is NO retry button, even for a failed job', async () => {
    stubFetch({ queueManage: false });
    wrap(<Jobs />);
    await waitFor(() => expect(screen.getByText('job-dead')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('with caps.queueManage exactly ONE retry button appears — on the failed row only', async () => {
    stubFetch({ queueManage: true });
    wrap(<Jobs />);
    await waitFor(() => expect(screen.getByText('job-dead')).toBeTruthy());
    const buttons = await screen.findAllByRole('button', { name: /retry/i });
    expect(buttons).toHaveLength(1); // not for 'done', not for 'queued'
  });

  it('clicking retry POSTs to /jobs/<id>/retry with the row id encoded', async () => {
    const calls = stubFetch({ queueManage: true });
    wrap(<Jobs />);
    const btn = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/jobs/job-dead/retry') && c.method === 'POST')).toBe(true));
  });

  it('a retry that fails does not leave the panel permanently locked', async () => {
    stubFetch({
      queueManage: true,
      onRetry: () => {
        throw new Error('queue unavailable');
      },
    });
    wrap(<Jobs />);
    const btn = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(btn);
    // the finally-block must clear busyId, otherwise one transient failure disables retry for the session
    await waitFor(() => expect((screen.getByRole('button', { name: /retry/i }) as HTMLButtonElement).disabled).toBe(false));
  });

  it('an id needing URL encoding is encoded, not sent raw', async () => {
    const calls = stubFetch({ queueManage: true, jobs: [{ id: 'a/b c', type: 'x', status: 'failed', attempts: 1 }] });
    wrap(<Jobs />);
    const btn = await screen.findByRole('button', { name: /retry/i });
    fireEvent.click(btn);
    await waitFor(() => expect(calls.some((c) => c.url.includes('a%2Fb%20c'))).toBe(true));
  });
});
