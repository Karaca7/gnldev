// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n'; // Observability now uses useTranslation — needs to be initialized in the test too (test-side counterpart of the side effect in main.tsx).
import { Badge, cn } from '../src/components';
import { Inspector } from '../src/views/Inspector';
import { Observability } from '../src/views/Observability';
import { Approvals } from '../src/views/Approvals';
import { Organizations } from '../src/views/Organizations';
import { Playground } from '../src/views/Playground';
import { diffWorkflowSteps } from '../src/views/workflow-diff';
import enPlayground from '../src/i18n/locales/en/playground.json';

// FLOW-10: submitEdit/regenerate's server-truncate fallback calls toast(...) / toast.error(...) —
// stub it (rest of '../src/ui' passes through untouched, e.g. Dialog/ConfirmDialog used elsewhere
// in this file) so those calls can be asserted on without needing a real <Toaster/> in the tree.
const { toastMock } = vi.hoisted(() => {
  const fn = vi.fn() as unknown as { (msg: string): void; error: ReturnType<typeof vi.fn> };
  (fn as any).error = vi.fn();
  return { toastMock: fn };
});
vi.mock('../src/ui', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/ui')>();
  return { ...actual, toast: toastMock };
});

// The live SSE path can't be driven through the fetch stub (streamAgent parses a ReadableStream), so
// the function itself is replaced and the test scripts the event sequence. Nothing else in this file
// streams, so the rest of the api module passes through untouched.
const { streamAgentMock } = vi.hoisted(() => ({ streamAgentMock: vi.fn() }));
vi.mock('../src/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/api')>();
  return { ...actual, streamAgent: streamAgentMock };
});

afterEach(() => {
  cleanup();
  localStorage.clear(); // don't let persistent selections like gnl-insp-run leak across tests
});

beforeEach(() => {
  toastMock.mockClear();
  toastMock.error.mockClear();
});

// recharts' ResponsiveContainer needs ResizeObserver; not present in jsdom → no-op stub.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
});

// Playground's smart auto-scroll drives the transcript box's own scrollTo (and scrollIntoView is what
// it must NOT use — see the containing-block regression guard below); jsdom implements neither.
Element.prototype.scrollIntoView = vi.fn();
Element.prototype.scrollTo = vi.fn() as unknown as Element['scrollTo'];

// framer-motion's Reveal (viewport) feature needs IntersectionObserver; not present in jsdom → no-op stub.
vi.stubGlobal('IntersectionObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() { return []; }
});

// api.ts's http() only uses res.ok / res.headers.get / res.json → a minimal mock is enough (not dependent on the Response global).
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
};

function wrap(node: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

describe('studio-ui components', () => {
  it('cn + Badge render', () => {
    expect(cn('a', false, undefined, 'b')).toBe('a b');
    wrap(<Badge tone="success">ok</Badge>);
    expect(screen.getByText('ok')).toBeTruthy();
  });

  it('Inspector fetches and shows the API run list (paginated endpoint)', async () => {
    stubFetch({
      '/capabilities': CAPS,
      '/runs?limit=50': { items: [{ runId: 'run-42', status: 'completed', modelSteps: 2, toolCalls: 1 }], total: 1 },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-42')).toBeTruthy());
    expect(screen.getByText(/2 model · 1 tool/)).toBeTruthy();
  });

  it('Inspector shows the empty-state invitation for an empty list', async () => {
    stubFetch({ '/capabilities': CAPS, '/runs?limit=50': { items: [], total: 0 } });
    wrap(<Inspector />);
    // D1-4: the bare "No runs." line became a full EmptyState (title + description + a
    // Playground CTA when that capability is on) — the first screen a fresh install lands on.
    await waitFor(() => expect(screen.getByText('No runs yet')).toBeTruthy());
  });

  it('Inspector purge: with caps.purge, trash button → confirmation dialog → DELETE /runs/:id', async () => {
    stubFetch({
      '/capabilities': { ...CAPS, purge: true },
      '/runs?limit=50': { items: [{ runId: 'run-42', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 1 },
      '/runs/run-42/cost': { totalTokens: 10, costUsd: 0.01 },
      '/runs/run-42/scores': { scores: {} },
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-42')).toBeTruthy());
    fireEvent.click(screen.getByText('run-42')); // select the run → RunDetail opens
    const purgeBtn = await screen.findByTitle('Permanently delete this run (GDPR purge)');
    fireEvent.click(purgeBtn);
    // D4-2: one verb across the chain — trigger "Delete" → confirm "Delete permanently" → toast
    // "Run permanently deleted". The trigger stays short so it fits beside Unwind/Cancel.
    fireEvent.click(await screen.findByText('Delete permanently')); // confirm the dialog
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const del = calls.find(([u, init]: any[]) => String(u).endsWith('/runs/run-42') && init?.method === 'DELETE');
      expect(del).toBeTruthy();
    });
  });

  it('Organizations retention panel: visible with caps.retention → confirm sweep → POST /retention/sweep + result badges', async () => {
    stubFetch({
      '/retention/sweep': { ok: true, scanned: 5, purged: ['a', 'b'], keptSuspended: 1, keptNoTs: 0, deletedEntries: 12 },
      '/capabilities': { ...CAPS, organizations: true, retention: true },
      '/organizations': { organizations: [] },
    });
    wrap(<Organizations />);
    await waitFor(() => expect(screen.getByText('Retention sweep')).toBeTruthy());
    fireEvent.click(screen.getByText('Sweep')); // panel button → dialog
    const confirm = (await screen.findAllByText('Sweep')).at(-1)!; // the confirm button in the dialog
    fireEvent.click(confirm);
    await waitFor(() => expect(screen.getByText('2 deleted')).toBeTruthy());
    expect(screen.getByText('5 scanned')).toBeTruthy();
    expect(screen.getByText('1 kept suspended')).toBeTruthy();
    const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
    const post = calls.find(([u, init]: any[]) => String(u).endsWith('/retention/sweep') && init?.method === 'POST');
    expect(post).toBeTruthy();
    expect(JSON.parse((post![1] as any).body).olderThanMs).toBe(30 * 86_400_000);
  });

  it('Inspector pagination: with a nextCursor, "load more" appends the next page', async () => {
    stubFetch({
      // endsWith match: the cursor'd URL only hits the cursor'd key, no collision.
      '/runs?limit=50&cursor=50': { items: [{ runId: 'run-old', status: 'completed', modelSteps: 1, toolCalls: 0 }], total: 2 },
      '/runs?limit=50': { items: [{ runId: 'run-new', status: 'completed', modelSteps: 1, toolCalls: 0 }], nextCursor: '50', total: 2 },
      '/capabilities': CAPS,
    });
    wrap(<Inspector />);
    await waitFor(() => expect(screen.getByText('run-new')).toBeTruthy());
    const more = screen.getByText(/load more \(1\/2\)/);
    fireEvent.click(more.closest('button')!);
    await waitFor(() => expect(screen.getByText('run-old')).toBeTruthy());
    expect(screen.queryByText(/load more/)).toBeNull(); // last page → button disappears
  });

  it('Observability: renders cards + p95 + the rich run table', async () => {
    // Note: the '/metrics/runs' key must come BEFORE '/runs' (stubFetch's endsWith takes the
    // first match). API-10: useMetricsRuns now sends a default `?limit=200` (see api.ts) instead of an
    // unbounded request.
    stubFetch({
      '/metrics/runs': {
        runs: [
          { runId: 'obs-1', status: 'completed', modelSteps: 2, toolCalls: 1, startTs: 1_700_000_000_000, durationMs: 850, costUsd: 0.0123, totalTokens: 420 },
          { runId: 'obs-2', status: 'suspended', modelSteps: 1, toolCalls: 0, startTs: 1_700_000_100_000, durationMs: 1900, costUsd: 0.002, totalTokens: 80 },
        ],
      },
      '/metrics': { total: 2, byStatus: { completed: 1, suspended: 1 }, costUsd: 0.0143, tokens: 500 },
      '/capabilities': CAPS,
      '/runs': [],
    });
    wrap(<Observability />);
    await waitFor(() => expect(screen.getByText('obs-1')).toBeTruthy());
    expect(screen.getByText('Duration p95')).toBeTruthy();
    expect(screen.getAllByText('1.9s').length).toBeGreaterThanOrEqual(2); // p95 card + table row (1900ms)
    expect(screen.getByText('850ms')).toBeTruthy(); // table duration column
    expect(screen.getByText('$0.0123')).toBeTruthy(); // table cost column
  });

  it('diffWorkflowSteps: aligns matching/diverging/one-sided steps', () => {
    const a = [
      { stepId: 'validate', output: { ok: true } },
      { stepId: 'aggregate', output: { items: 3 } },
      { stepId: 'approve', output: { approved: true } },
    ];
    const b = [
      { stepId: 'validate', output: { ok: true } }, // replay — same
      { stepId: 'aggregate', output: { items: 5 } }, // diverges
      { stepId: 'notify', output: { sent: true } }, // B only
    ];
    const rows = diffWorkflowSteps(a, b);
    expect(rows.map((r) => [r.stepId, r.equal])).toEqual([
      ['validate', true],
      ['aggregate', false],
      ['approve', false], // A only → diverges
      ['notify', false], // B only, appended at the end
    ]);
    expect(rows[2].b).toBeUndefined();
    expect(rows[3].a).toBeUndefined();
  });

  it('Playground: switching agents clears the loaded thread (no leftover conversation from the previous agent)', async () => {
    stubFetch({
      '/capabilities': { ...CAPS, playground: true, memory: true },
      '/agents': [
        { name: 'alpha', model: 'm', hasTools: false },
        { name: 'beta', model: 'm', hasTools: false },
      ],
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      '/threads?resourceId=studio-user': [{ id: 't-1', title: 'Old chat', resourceId: 'studio-user', createdAt: 1, updatedAt: 1 }],
      '/threads/t-1/messages': [{ role: 'user', content: 'message from the old thread' }],
    });
    wrap(<Playground />);
    // Pick the past conversation → its history is restored into the chat pane.
    fireEvent.click(await screen.findByText('Old chat'));
    await waitFor(() => expect(screen.getByText('message from the old thread')).toBeTruthy());
    // Switch agents → the previous agent's conversation must NOT linger.
    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'beta' } });
    await waitFor(() => expect(screen.queryByText('message from the old thread')).toBeNull());
  });

  // FORM-08 — switching agents resets the CONVERSATION (see the test above) but must NOT throw away
  // whatever the user was mid-typing in the composer: the reset is about not appending the new agent's
  // turns into the old agent's thread, not about the prompt itself, which is unrelated to which agent
  // it eventually gets sent to.
  it('Playground FORM-08: switching agents clears the thread but keeps the in-progress composer text', async () => {
    stubFetch({
      '/capabilities': { ...CAPS, playground: true, memory: true },
      '/agents': [
        { name: 'alpha', model: 'm', hasTools: false },
        { name: 'beta', model: 'm', hasTools: false },
      ],
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      '/threads?resourceId=studio-user': [{ id: 't-1', title: 'Old chat', resourceId: 'studio-user', createdAt: 1, updatedAt: 1 }],
      '/threads/t-1/messages': [{ role: 'user', content: 'message from the old thread' }],
    });
    wrap(<Playground />);
    fireEvent.click(await screen.findByText('Old chat'));
    await waitFor(() => expect(screen.getByText('message from the old thread')).toBeTruthy());

    const textarea = screen.getByPlaceholderText(enPlayground.messagePlaceholder) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'a prompt worth keeping' } });

    fireEvent.change(screen.getByLabelText('Agent'), { target: { value: 'beta' } });

    // The old thread's messages are gone (conversation reset) …
    await waitFor(() => expect(screen.queryByText('message from the old thread')).toBeNull());
    // … but the composer the user was mid-typing survives the reset.
    expect((screen.getByPlaceholderText(enPlayground.messagePlaceholder) as HTMLTextAreaElement).value)
      .toBe('a prompt worth keeping');
  });

  // REGRESSION GUARD — "messages vanished, huge blank area below the last visible line".
  // The transcript used to be a <Stagger>/<StaggerItem> list. Stagger propagates its "hidden" → "show"
  // variant to children only when the PARENT's animate state changes, i.e. once, at mount — and this
  // list mounts EMPTY (`msgs` starts as []). Every message appended afterwards (stream delta, thread
  // load, regenerate) therefore mounted as a late child and stayed on the `hidden` variant forever:
  // framer-motion wrote `opacity: 0; transform: translateY(6px)` inline, so the bubble was invisible
  // while still occupying its full height — a blank scroll area that scrolled as if content were there.
  // A chat transcript must not be gated behind an entrance animation, so: no motion-driven inline
  // opacity anywhere in it. Also pins the scroll container's shape (nothing between the transcript
  // and the end of the scroll box may take flow space) so auto-scroll stays correct.
  it('Playground: the transcript renders unconditionally visible (no motion-gated opacity)', async () => {
    stubFetch({
      '/capabilities': { ...CAPS, playground: true, memory: true },
      '/agents': [{ name: 'alpha', model: 'm', hasTools: false }],
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      '/threads?resourceId=studio-user': [{ id: 't-1', title: 'Old chat', resourceId: 'studio-user', createdAt: 1, updatedAt: 1 }],
      '/threads/t-1/messages': [
        { role: 'user', content: 'question from the restored thread' },
        { role: 'assistant', content: 'answer from the restored thread' },
      ],
    });
    const { container } = wrap(<Playground />);
    fireEvent.click(await screen.findByText('Old chat'));
    await waitFor(() => expect(screen.getByText('question from the restored thread')).toBeTruthy());
    expect(screen.getByText('answer from the restored thread')).toBeTruthy();

    const scroller = container.querySelector('.h-full.space-y-2.overflow-auto') as HTMLElement;
    expect(scroller).toBeTruthy();
    const transcript = scroller.children[0] as HTMLElement;

    // (a) Nothing inside the transcript may hide itself behind an animation — a bubble at opacity 0
    //     is invisible but still occupies its height, which is exactly the reported bug.
    const withInlineOpacity = Array.from(transcript.querySelectorAll<HTMLElement>('[style]'))
      .concat(transcript)
      .filter((el) => /opacity/.test(el.getAttribute('style') ?? ''));
    expect(withInlineOpacity.map((el) => el.getAttribute('style'))).toEqual([]);

    // (b) With neither an error nor a pending approval, the only thing after the transcript is the
    //     out-of-flow sr-only live region.
    const kids = Array.from(scroller.children) as HTMLElement[];
    expect(kids).toHaveLength(2);
    expect(kids[0].className).toContain('space-y-2'); // the transcript
    expect(kids[1].className).toContain('sr-only');   // position:absolute → takes no flow space
  });

  // REGRESSION GUARD — "the chat area is blank apart from a clipped fragment at the top".
  // Measured in a real browser (Chrome, 1440x900, a thread with tool calls → 4.4k px of transcript):
  //   wrapper (`relative flex-1 overflow-hidden`): scrollHeight 4438 vs clientHeight 572  → SCROLLABLE
  //   scroll box: getBoundingClientRect().top = -454px instead of 102px                   → pushed out of view
  // Cause: `.sr-only` is `position:absolute`. An absolutely positioned box is laid out and clipped by
  // its CONTAINING BLOCK and contributes to THAT block's scrollable overflow; an `overflow:auto`
  // ancestor in between does NOT clip it unless it is itself the containing block. While the scroll box
  // was `position:static`, the live region's containing block was the outer wrapper, and since its
  // static position sits at the very end of the transcript it stretched the WRAPPER's scroll height to
  // the full transcript height (4437px offsetTop + 1px = the 4438 measured above). `overflow:hidden`
  // still scrolls programmatically, so the auto-scroll then scrolled the wrapper and shifted the whole
  // scroll box out of view. Removing the live region from the DOM dropped the wrapper back to 572px and
  // restored the layout; putting it back reproduced the bug — that isolates it to this one element.
  // Two invariants keep it fixed, and this test pins both:
  //   1. the scroll box is POSITIONED → it is the containing block for its absolute descendants;
  //   2. auto-scroll drives that box's own scrollTop, never scrollIntoView (which walks the ancestor
  //      chain and scrolls every scrollable ancestor it finds — the mechanism that did the damage).
  it('Playground: the scroll box is positioned and auto-scroll never walks the ancestor chain', async () => {
    stubFetch({
      '/capabilities': { ...CAPS, playground: true, memory: true },
      '/agents': [{ name: 'alpha', model: 'm', hasTools: false }],
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      '/threads?resourceId=studio-user': [{ id: 't-1', title: 'Old chat', resourceId: 'studio-user', createdAt: 1, updatedAt: 1 }],
      '/threads/t-1/messages': [
        { role: 'user', content: 'question from the restored thread' },
        { role: 'assistant', content: 'answer from the restored thread' },
      ],
    });
    const scrollIntoViewSpy = Element.prototype.scrollIntoView as unknown as ReturnType<typeof vi.fn>;
    const scrollToSpy = Element.prototype.scrollTo as unknown as ReturnType<typeof vi.fn>;
    scrollIntoViewSpy.mockClear();
    scrollToSpy.mockClear();

    const { container } = wrap(<Playground />);
    fireEvent.click(await screen.findByText('Old chat'));
    await waitFor(() => expect(screen.getByText('question from the restored thread')).toBeTruthy());

    const scroller = container.querySelector('.h-full.space-y-2.overflow-auto') as HTMLElement;
    const wrapper = scroller.parentElement as HTMLElement;
    expect(wrapper.className).toContain('overflow-hidden');

    // 1. The scroll box must establish a containing block, otherwise absolute descendants escape it
    //    and inflate the outer wrapper's scrollable overflow.
    expect(scroller.className).toMatch(/(^|\s)relative(\s|$)/);

    // Every absolutely positioned descendant must resolve to a containing block AT OR BELOW the
    // scroll box — nothing may resolve to the wrapper. (`sr-only` is `position:absolute` too.)
    const abs = Array.from(scroller.querySelectorAll<HTMLElement>('.absolute, .sr-only'));
    expect(abs.length).toBeGreaterThan(0); // the live region at minimum — the check must not pass vacuously
    const escaped = abs.filter((el) => {
      for (let p: HTMLElement | null = el.parentElement; p; p = p.parentElement) {
        if (/(^|\s)(relative|absolute|fixed|sticky)(\s|$)/.test(p.className)) return false; // contained
        if (p === scroller) return true; // reached the scroll box without a positioned ancestor
      }
      return true;
    });
    expect(escaped.map((el) => el.className)).toEqual([]);

    // The a11y live region itself must still be there (the fix must not "solve" this by deleting it).
    const live = scroller.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live!.className).toContain('sr-only');

    // 2. Auto-scroll moved the scroll box directly and did NOT use scrollIntoView.
    expect(scrollIntoViewSpy).not.toHaveBeenCalled();
    expect(scrollToSpy).toHaveBeenCalled();
    expect(scrollToSpy.mock.instances[0]).toBe(scroller);
    expect(scrollToSpy.mock.calls[0][0]).toMatchObject({ behavior: 'smooth' });
  });

  // FLOW-10: edit & resend must also truncate the PERSISTED thread on the server, not just the local
  // view — otherwise the next run sees both the abandoned original message and the corrected one.
  // A method-aware fetch stub is needed here (unlike stubFetch above) because the truncate DELETE and
  // the history-reload GET hit the exact same URL (/threads/:id/messages).
  function stubFetchWithTruncate(opts: { truncateOk: boolean }) {
    const routes: Record<string, unknown> = {
      '/capabilities': { ...CAPS, playground: true, memory: true },
      '/agents': [{ name: 'alpha', model: 'm', hasTools: false }],
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      '/threads?resourceId=studio-user': [{ id: 't-1', title: 'Old chat', resourceId: 'studio-user', createdAt: 1, updatedAt: 1 }],
      '/threads/t-1/messages': [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'first answer' },
      ],
      '/agents/alpha/run': { text: 'edited answer' },
      '/cost': { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
    };
    vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (u.endsWith('/threads/t-1/messages') && method === 'DELETE') {
        return opts.truncateOk
          ? { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => ({ ok: true, removed: 1 }) }
          : {
              ok: false, status: 501,
              headers: { get: () => 'application/json' },
              json: async () => ({ error: 'truncateMessages is not supported' }),
              clone() { return this; },
            };
      }
      const key = Object.keys(routes).find((k) => u.endsWith(k));
      return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => (key ? routes[key] : []) };
    }));
  }

  async function openAndSubmitEdit() {
    fireEvent.click(await screen.findByText('Old chat'));
    await waitFor(() => expect(screen.getByText('first')).toBeTruthy());
    fireEvent.click(screen.getByTitle('Edit & resend'));
    fireEvent.change(screen.getByLabelText('Edit message'), { target: { value: 'first edited' } });
    fireEvent.click(screen.getByText('Save & send'));
  }

  it('Playground submitEdit: truncates the server thread (DELETE with the correct afterIndex) before re-running the edited message', async () => {
    stubFetchWithTruncate({ truncateOk: true });
    wrap(<Playground />);
    await openAndSubmitEdit();

    // The edited message (local index 0) is also server index 0 (a plain 2-message history, 1:1 here) →
    // "keep through index -1" = drop everything, since the edited turn replaces the very first turn.
    await waitFor(() => {
      const calls = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls;
      const del = calls.find(([u, init]: any[]) => String(u).endsWith('/threads/t-1/messages') && init?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(JSON.parse((del![1] as any).body)).toEqual({ afterIndex: -1 });
    });
    // Truncate succeeded (200) → the old "stale history" fallback toast must NOT fire.
    expect(toastMock).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText('edited answer')).toBeTruthy());
  });

  it('Playground submitEdit: a 501 (adapter has no truncateMessages) falls back to the old "stale history" toast, and the run still proceeds', async () => {
    stubFetchWithTruncate({ truncateOk: false });
    wrap(<Playground />);
    await openAndSubmitEdit();

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(enPlayground.staleHistoryWarning));
    // Not blocked by the 501 — the edited prompt still ran and produced a response.
    await waitFor(() => expect(screen.getByText('edited answer')).toBeTruthy());
  });

  it('Approvals: lists the pending approval, Approve/Deny buttons are visible', async () => {
    stubFetch({
      '/approvals': { items: [{ runId: 'sus-1', toolCallId: 'call-1', toolName: 'chargeCard', args: { amount: 99 }, reason: 'high amount' }] },
      '/capabilities': CAPS,
    });
    wrap(<Approvals />);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());
    expect(screen.getByText('Approve')).toBeTruthy();
    expect(screen.getByText('Deny')).toBeTruthy();
    expect(screen.getByText(/high amount/)).toBeTruthy();
  });
});

// The Playground used to express "a run is in flight" ONLY by disabling the Send button, so a slow
// turn and a hung one looked the same. The server was already streaming the answer — reasoning-*,
// tool-input-*, tool-call, step-* — and the client dropped all of it. These cover both halves: the
// indicator now reports the real phase, and a failing tool actually ends.
describe('Playground — live progress', () => {
  const STREAM_CAPS = { ...CAPS, playground: true, stream: true };

  function stubPlayground() {
    stubFetch({
      '/capabilities': STREAM_CAPS,
      '/agents': [{ name: 'alpha', model: 'm', hasTools: true }],
      '/me': { id: null, roles: [], orgId: null, operator: true, platformAdmin: false, scope: 'none' },
      // The run's finally block fetches this; without a real shape the stub's [] fallback used to
      // reach the token readout as `undefined.toFixed(4)`.
      '/cost': { totalTokens: 12, costUsd: 0.0034 },
    });
  }

  async function sendPrompt() {
    const box = await screen.findByPlaceholderText(enPlayground.messagePlaceholder);
    fireEvent.change(box, { target: { value: 'go' } });
    fireEvent.click(screen.getByText(enPlayground.sendButton));
  }

  it('names the tool it is executing, instead of just greying out the button', async () => {
    stubPlayground();
    // Hold the stream open after the tool-call so the mid-run UI can be inspected.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    streamAgentMock.mockImplementation(async (_n: string, _b: unknown, on: (e: unknown) => void) => {
      on({ type: 'step-start', data: {} });
      on({ type: 'tool-call', data: { toolCallId: 'c1', toolName: 'searchDocs', input: { q: 'x' } } });
      await held;
    });
    wrap(<Playground />);
    await sendPrompt();

    await waitFor(() => expect(screen.getByText(/Running searchDocs/)).toBeTruthy());
    release();
  });

  it('reports thinking while the model reasons and produces no output at all', async () => {
    stubPlayground();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    streamAgentMock.mockImplementation(async (_n: string, _b: unknown, on: (e: unknown) => void) => {
      on({ type: 'reasoning-start', data: {} });
      await held;
    });
    wrap(<Playground />);
    await sendPrompt();

    // Nothing is written to the transcript during this phase — it is the emptiest, most alarming
    // stretch of a run, and previously the screen showed no sign of life whatsoever.
    await waitFor(() => expect(screen.getByText(enPlayground.activityThinking)).toBeTruthy());
    release();
  });

  it('REGRESSION: a tool that FAILS stops claiming to be running', async () => {
    stubPlayground();
    streamAgentMock.mockImplementation(async (_n: string, _b: unknown, on: (e: unknown) => void) => {
      on({ type: 'tool-call', data: { toolCallId: 'c1', toolName: 'searchDocs', input: { q: 'x' } } });
      on({ type: 'tool-error', data: { toolCallId: 'c1', toolName: 'searchDocs', error: 'boom' } });
    });
    wrap(<Playground />);
    await sendPrompt();

    // The tool card stays on screen, but as a FINISHED (failed) one. Before the fix the tool-error
    // event had no handler at all, so `output` stayed undefined and the card pulsed "running" for
    // the rest of the session, long after the run had ended.
    await waitFor(() => expect(screen.getByText('searchDocs')).toBeTruthy());
    await waitFor(() => expect(screen.queryByText(enPlayground.runningLabel)).toBeNull());
    expect(screen.getAllByText(/boom/).length).toBeGreaterThan(0);
  });

  it('clears the indicator once the run ends', async () => {
    stubPlayground();
    streamAgentMock.mockImplementation(async (_n: string, _b: unknown, on: (e: unknown) => void) => {
      on({ type: 'reasoning-start', data: {} });
    });
    wrap(<Playground />);
    await sendPrompt();
    await waitFor(() => expect(screen.queryByText(enPlayground.activityThinking)).toBeNull());
  });
});
