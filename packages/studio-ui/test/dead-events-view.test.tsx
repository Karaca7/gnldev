// @vitest-environment jsdom
// Dead-letter view. Modelled on jobs-view.test.tsx, but the properties under test are the ones where
// the events bus is NOT the queue:
//   1. the list is addressed by (topic, consumer) and is not fetched until both are chosen;
//   2. it does NOT poll — `listDeadEvents` scans the whole topic log, so the refresh is a button;
//   3. `delivered` is the one terminal status: released rows keep an action (re-asserting a release
//      is the documented way out of the rescan-flag race), delivered rows do not;
//   4. the release POST carries the whole triple, not just the id.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { DeadEvents } from '../src/views/DeadEvents';

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

const DEAD = [
  { id: 'evt-stuck', topic: 'orders.created', consumer: 'billing', status: 'quarantined', error: 'gateway 500', attempts: 8, at: 1 },
  { id: 'evt-back', topic: 'orders.created', consumer: 'billing', status: 'released', error: 'gateway 500', attempts: 8, at: 2, releases: 1 },
  { id: 'evt-fine', topic: 'orders.created', consumer: 'billing', status: 'delivered', error: 'gateway 500', attempts: 8, at: 3, releases: 1 },
];

function stubFetch(opts: { dead?: unknown; eventsManage?: boolean; deadEvents?: boolean; onRelease?: () => unknown } = {}) {
  const calls: Array<{ url: string; method: string; body?: string }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, method: init?.method ?? 'GET', body: init?.body as string | undefined });
    let body: unknown = [];
    if (u.includes('/capabilities')) {
      body = { deadEvents: opts.deadEvents ?? true, eventsManage: opts.eventsManage ?? false };
    } else if (u.includes('/dead-events/release')) {
      body = opts.onRelease ? opts.onRelease() : { ok: true };
    } else if (u.includes('/dead-events/topics')) {
      body = [{ topic: 'orders.created', consumers: ['billing', 'search'] }];
    } else if (u.includes('/dead-events')) {
      body = opts.dead ?? DEAD;
    }
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
  }));
  return calls;
}

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
  return qc;
}

/** Fills the two address boxes and presses Load — the only way this view fetches a list. */
async function loadList(topic = 'orders.created', consumer = 'billing') {
  fireEvent.change(await screen.findByLabelText(/topic|konu/i), { target: { value: topic } });
  fireEvent.change(screen.getByLabelText(/consumer|tüketici/i), { target: { value: consumer } });
  fireEvent.click(screen.getByRole('button', { name: /load/i }));
}

describe('Dead-letter view', () => {
  it('fetches NOTHING until a topic and a consumer are chosen', async () => {
    const calls = stubFetch();
    wrap(<DeadEvents />);
    // The topic inventory is fine to fetch (it is cheap); the whole-log scan is not.
    await waitFor(() => expect(calls.some((c) => c.url.includes('/dead-events/topics'))).toBe(true));
    expect(calls.some((c) => /\/dead-events\?/.test(c.url)),
      'the expensive topic-log scan ran before an operator asked for it').toBe(false);
    expect(screen.queryByText('evt-stuck')).toBeNull();
  });

  it('loads the list for the chosen pair, sending both as query parameters', async () => {
    const calls = stubFetch();
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();

    await waitFor(() => expect(screen.getByText('evt-stuck')).toBeTruthy());
    const listCall = calls.find((c) => /\/dead-events\?/.test(c.url))!;
    expect(listCall.url).toContain('topic=orders.created');
    expect(listCall.url).toContain('consumer=billing');
  });

  it('does not poll — the list query carries no refresh interval', async () => {
    // Asserted on the query itself rather than by waiting out an interval: a wall-clock test would
    // have to outlast the longest interval anyone might add (useJobs is on 3s) to mean anything, and
    // would still pass for a 60s one. What must be true is that the query has NO interval at all.
    stubFetch();
    const qc = wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();
    await waitFor(() => expect(screen.getByText('evt-stuck')).toBeTruthy());

    const q = qc.getQueryCache().find({ queryKey: ['dead-events', 'orders.created', 'billing'] })!;
    expect(q, 'the list query was never created — the assertion below would be vacuous').toBeTruthy();
    expect((q.options as { refetchInterval?: unknown }).refetchInterval,
      'the whole-topic-log scan was put on a timer').toBeUndefined();
    // And re-mounting must not silently re-run the scan either.
    expect((q.options as { staleTime?: unknown }).staleTime).toBe(Infinity);
  });

  it('without caps.eventsManage there is NO release button, even on a quarantined row', async () => {
    stubFetch({ eventsManage: false });
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();
    await waitFor(() => expect(screen.getByText('evt-stuck')).toBeTruthy());
    expect(screen.queryByRole('button', { name: /release/i })).toBeNull();
  });

  it('with caps.eventsManage the quarantined AND released rows are actionable — the delivered one is not', async () => {
    stubFetch({ eventsManage: true });
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();

    // Two buttons for three rows: `delivered` is terminal, `released` is not (re-asserting a release
    // is the only way out of the swallowed-rescan-flag race).
    const buttons = await screen.findAllByRole('button', { name: /release/i });
    expect(buttons).toHaveLength(2);
    expect(screen.getByRole('button', { name: /release again/i }), 'a re-release reads as a plain repeat').toBeTruthy();
  });

  it('releasing POSTs the whole triple, not just the event id', async () => {
    const calls = stubFetch({ eventsManage: true });
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();

    const btn = (await screen.findAllByRole('button', { name: /^release$/i }))[0]!;
    fireEvent.click(btn);

    await waitFor(() => {
      const call = calls.find((c) => c.url.includes('/dead-events/release') && c.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse(call!.body!)).toEqual({ topic: 'orders.created', consumer: 'billing', id: 'evt-stuck' });
    });
  });

  it('a failed release does not leave the panel permanently locked', async () => {
    stubFetch({ eventsManage: true, onRelease: () => { throw new Error('events store unavailable'); } });
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();

    const btn = (await screen.findAllByRole('button', { name: /^release$/i }))[0]!;
    fireEvent.click(btn);
    await waitFor(() => {
      const again = screen.getAllByRole('button', { name: /^release$/i })[0] as HTMLButtonElement;
      expect(again.disabled).toBe(false);
    });
  });

  it('a topic or consumer needing URL encoding is encoded, not sent raw', async () => {
    const calls = stubFetch();
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList('billing/invoices', 'a b');

    await waitFor(() => expect(calls.some((c) => c.url.includes('billing%2Finvoices') && c.url.includes('a%20b'))).toBe(true));
  });

  /**
   * The strip is the largest type on the page, and before a scan has run it has nothing to count.
   *
   * The server refuses a request that names no consumer for exactly this reason — "answering it with
   * an empty list would read as 'nothing is quarantined'" (server.ts) — and the view was making that
   * same claim in three digits before anything had been fetched.
   */
  it('does not claim "0 quarantined" before a scan has run', async () => {
    stubFetch();
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });

    expect(screen.queryAllByText('0'), 'the empty page reports counts it has not measured').toHaveLength(0);
    expect(screen.getAllByText('—').length, 'the strip vanished instead of admitting it has no number').toBe(3);

    await loadList();
    // And once a list IS loaded, an honest zero is a zero: two of the three DEAD rows are not
    // quarantined, so the placeholder must not survive the fetch.
    await waitFor(() => expect(screen.queryAllByText('—')).toHaveLength(0));
  });

  it('announces the scan while it runs — the longest wait in the app', async () => {
    // `aria-busy` on the button was the only feedback: nothing told a screen-reader user that the
    // list had arrived, on the one page where the wait is seconds rather than milliseconds.
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (/\/dead-events\?/.test(u)) await gate;
      const body = u.includes('/capabilities') ? { deadEvents: true }
        : u.includes('/dead-events/topics') ? []
          : /\/dead-events\?/.test(u) ? DEAD : [];
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => body };
    }));
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();

    const status = await screen.findByRole('status');
    expect(status.textContent, 'the live region says nothing about what is being waited on').toMatch(/scan|tara/i);
    release();
    await waitFor(() => expect(screen.getByText('evt-stuck')).toBeTruthy());
    expect(screen.queryByRole('status'), 'the "scanning" announcement outlived the scan').toBeNull();
  });

  it('spins the row button that was pressed, not the one at the top of the page', async () => {
    // `disabled={busyId !== null}` alone greys out every row and moves nothing. The only thing that
    // used to spin was Refresh, which is bound to `dead.isFetching` — the wrong control entirely.
    let settle!: () => void;
    const held = new Promise<void>((r) => { settle = r; });
    const calls = stubFetch({ eventsManage: true, onRelease: () => held.then(() => ({ ok: true })) });
    void calls;
    wrap(<DeadEvents />);
    await screen.findByRole('button', { name: /load/i });
    await loadList();

    const pressed = (await screen.findAllByRole('button', { name: /^release$/i }))[0]!;
    fireEvent.click(pressed);

    await waitFor(() => {
      const busy = screen.getAllByRole('button').filter((b) => b.getAttribute('aria-busy') === 'true');
      expect(busy.map((b) => b.textContent), 'the wrong button reported itself as working').toEqual([pressed.textContent]);
    });
    settle();
  });

  /**
   * The row expander: the ONLY route to the untruncated error, and the only place the event body
   * appears at all.
   */
  describe('the expandable row', () => {
    const withBody = [{
      id: 'evt-stuck', topic: 'orders.created', consumer: 'billing', status: 'quarantined',
      error: 'gateway 500 — upstream refused after 8 attempts, last body: <html>502 Bad Gateway</html>',
      attempts: 8, at: 1, payload: { orderId: 'o-1', customerEmail: 'jane@customer.example' },
    }];

    it('is a real control, and reveals the full error a `title` tooltip could only give a mouse', async () => {
      // ASSERTED ON THE DISCLOSURE, NOT ON THE CLIPPING. jsdom does no layout, so the `truncate` cell
      // reports the whole string here whatever the browser paints — a "the text is cut off" assertion
      // would be a claim this environment cannot make. What it CAN prove is the part that was broken:
      // that a keyboard user has a control at all, that it says what it does, and that the region it
      // names is not in the document until it is opened.
      stubFetch({ dead: withBody });
      wrap(<DeadEvents />);
      await screen.findByRole('button', { name: /load/i });
      await loadList();

      const toggle = await screen.findByRole('button', { name: /evt-stuck/ });
      expect(toggle.getAttribute('aria-expanded'), 'a disclosure a screen reader cannot read').toBe('false');
      const target = toggle.getAttribute('aria-controls')!;
      expect(target, 'the control names no region').toBeTruthy();
      expect(document.getElementById(target), 'the detail row is mounted for every row up front').toBeNull();

      fireEvent.click(toggle);
      expect(toggle.getAttribute('aria-expanded')).toBe('true');
      const panel = document.getElementById(target)!;
      expect(panel, 'the control expanded nothing').toBeTruthy();
      expect(panel.textContent, 'the full error is still reachable only by hovering').toContain('502 Bad Gateway');
    });

    it('shows the event body — the thing a release actually re-runs a handler on', async () => {
      stubFetch({ dead: withBody });
      wrap(<DeadEvents />);
      await screen.findByRole('button', { name: /load/i });
      await loadList();

      fireEvent.click(await screen.findByRole('button', { name: /evt-stuck/ }));
      expect(screen.getByText(/jane@customer.example/), 'the body was fetched and then never rendered').toBeTruthy();
    });

    it('asks the server for the body — a second request would mean a second whole-log scan', async () => {
      const calls = stubFetch({ dead: withBody });
      wrap(<DeadEvents />);
      await screen.findByRole('button', { name: /load/i });
      await loadList();
      await screen.findByRole('button', { name: /evt-stuck/ });

      const scans = calls.filter((c) => /\/dead-events\?/.test(c.url));
      expect(scans, 'the expander bought a second scan of the whole topic log').toHaveLength(1);
      expect(scans[0]!.url, 'the body was never asked for, so the expander has nothing to show').toContain('payload=1');
    });

    /**
     * `errorRestricted` — the OTHER half of the same rule, and the untested one.
     *
     * `error` ships in the default answer, so unlike the body it does not even have to be asked for;
     * the server moved it behind `payloads:read` because a handler's message routinely quotes the
     * event body it rejected. The view then has two places to get it wrong, and both were unasserted:
     * the table cell (rendered for every row) and the expander (the only untruncated copy).
     */
    it('says the ERROR is withheld — in the row AND in the expander — rather than rendering an empty cell', async () => {
      // A blank error column reads as "this delivery failed for no recorded reason", which is a claim
      // about the RECORD. The truth is a fact about the VIEWER, and it is actionable (`payloads:read`).
      stubFetch({ dead: [{ ...withBody[0], error: undefined, errorRestricted: true }] });
      wrap(<DeadEvents />);
      await screen.findByRole('button', { name: /load/i });
      await loadList();

      const toggle = await screen.findByRole('button', { name: /evt-stuck/ });
      const row = toggle.closest('tr')!;
      expect(row.textContent, 'the error column is blank, so the row claims there was no reason').toMatch(/hidden|gizli/i);

      fireEvent.click(toggle);
      const panel = document.getElementById(toggle.getAttribute('aria-controls')!)!;
      expect(panel.textContent, 'the expander offers no way to find out why the text is missing').toMatch(/payloads:read/);
      // And the surrounding row still answers the question this operator IS entitled to ask.
      expect(row.textContent, 'withholding the error took the operational half of the row with it').toContain('8');
    });

    it('renders the error normally when the server did not withhold it', async () => {
      // Without this the assertion above is satisfied by showing "hidden" to everyone.
      stubFetch({ dead: withBody });
      wrap(<DeadEvents />);
      await screen.findByRole('button', { name: /load/i });
      await loadList();

      const row = (await screen.findByRole('button', { name: /evt-stuck/ })).closest('tr')!;
      expect(row.textContent).toContain('gateway 500');
      expect(row.textContent, 'an error the caller may read was reported as withheld').not.toMatch(/hidden|gizli/i);
    });

    it('says the body is withheld rather than showing an empty one, when the server withholds it', async () => {
      // `payload: undefined` and "you may not see this" are different facts, and the second one is
      // actionable (`payloads:read`). The server distinguishes them; the view has to as well.
      stubFetch({ dead: [{ ...withBody[0], payload: undefined, payloadRestricted: true }] });
      wrap(<DeadEvents />);
      await screen.findByRole('button', { name: /load/i });
      await loadList();

      fireEvent.click(await screen.findByRole('button', { name: /evt-stuck/ }));
      expect(screen.getByText(/payloads:read/), 'a restricted body reads as "this event carried none"').toBeTruthy();
    });

    it('keeps ONE row open — 200 rows must not mean 200 mounted JSON trees', async () => {
      stubFetch();
      wrap(<DeadEvents />);
      await screen.findByRole('button', { name: /load/i });
      await loadList();

      const first = await screen.findByRole('button', { name: /evt-stuck/ });
      const second = screen.getByRole('button', { name: /evt-back/ });
      fireEvent.click(first);
      fireEvent.click(second);

      expect(first.getAttribute('aria-expanded')).toBe('false');
      expect(second.getAttribute('aria-expanded')).toBe('true');
      expect(document.querySelectorAll('[id^="dead-detail-"]'),
        'more than one detail row was mounted at a time').toHaveLength(1);

      // And it closes itself: a disclosure whose only exit is opening a different one is a trap for
      // whoever opened the last row in the list.
      fireEvent.click(second);
      expect(second.getAttribute('aria-expanded')).toBe('false');
      expect(document.querySelectorAll('[id^="dead-detail-"]')).toHaveLength(0);
    });
  });

  it('shows the disabled state — not an empty list — when the host wired no events object', async () => {
    stubFetch({ deadEvents: false });
    wrap(<DeadEvents />);
    expect(await screen.findByText(/dead-letter view is off/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /load/i }), 'the address form is offered for a surface that is not wired').toBeNull();
  });
});
