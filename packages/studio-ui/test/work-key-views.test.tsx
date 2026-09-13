// @vitest-environment jsdom
// PAKET #6 — the operator's screens learn the word `workKey`.
//
// WHY THESE THREE VIEWS AND WHY NOW. Package #3 turned the run id into `run1_<32 hex>`: a digest of
// (agent, scope, subject, workKey). Everything an operator used to read off an id — which invoice,
// which nightly batch, which device rollout — left the id at that moment and moved into ONE field on
// the run's record. Observability's table, the Inspector's detail header and the approval inbox are
// the three places a human looks at a run they did not start, so they are the three places where a
// hash with no label is a screen that cannot be used. Workflows' suspended inbox already got its
// badge in package #4; this file pins the rest, plus the shared rule below.
//
// THE CONDITIONAL-COLUMN RULE, restated because it is the easiest one to get subtly wrong: a
// deployment where nobody declares a workKey must see NO work-key column at all — not a column of
// dashes. The dedup-profile row in `describeProtections` earns its place the same way. A column that
// is always there and always empty teaches the reader that the field is broken.
//
// AND THE `#` SUFFIXES. `run1_<hex>#2` (second deliberate execution), `#fork-1`, `#replay-0` are
// engine spellings, and `#` is the one character a URL reads as "the rest is a fragment". A run link
// that does not percent-encode it drops the suffix silently — the operator lands on the BASE run and
// nothing on screen says they did. So the ids are asserted whole, in the text and in the link.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { Observability, runsToCsv } from '../src/views/Observability';
import { Inspector } from '../src/views/Inspector';
import { Approvals } from '../src/views/Approvals';
import enObs from '../src/i18n/locales/en/observability.json';
import enIns from '../src/i18n/locales/en/inspector.json';
import enApr from '../src/i18n/locales/en/approvals.json';

// NOT `vi.unstubAllGlobals()`: the two observer stubs below are module-level, and unstubbing after
// the first test takes recharts' ResizeObserver away from every test after it.
afterEach(() => { cleanup(); localStorage.clear(); });

vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } });

/**
 * "No work-key badge anywhere on this screen", asked in the badge's OWN words.
 *
 * Both absence checks used to be a literal `/^work:/`. That regex is the English template's prefix
 * copied by hand, so it stops asking the question the moment the copy changes: rename the badge to
 * `job:` and the assertion still passes — against a screen that now renders a badge on every row.
 * It is already wrong in Turkish (`iş: {{workKey}}`), which is the same file, one locale over.
 *
 * Derived from the template instead: take everything before the interpolation and match on that. If
 * the wording moves, this moves with it; if the badge appears when it must not, this fails.
 */
function noBadge(template: string): RegExp {
  const prefix = template.split('{{workKey}}')[0]!.trim();
  // The prefix is display copy, not a pattern — a locale is free to put `?` or `(` in it.
  return new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

const CAPS = {
  resume: false, chat: false, fork: false, playground: false, stream: false, tools: false,
  toolExec: false, toolExecDurable: false, memory: false, workflows: false, workflowExec: false,
  scorers: false, datasets: false, mcp: false, a2a: false,
};

/** `includes`, not `endsWith`: a derived runId is percent-encoded into the path, so a route key like
 *  `/trace` has to match a URL whose middle segment is `run1_…%232`.
 *
 *  LONGEST KEY FIRST, and that is not a tidying. `includes` makes every key a prefix-matcher, so
 *  with `{'/runs': …, '/runs/x/trace': …}` a request for the trace URL matches BOTH and the winner
 *  was whichever came first in object-literal order — i.e. the fixture's answer depended on the
 *  order someone happened to type the routes in, and the more specific stub was the one that lost.
 *  A test that quietly serves the wrong fixture still renders something, which is the failure mode
 *  worth spending four characters on. Sorting by length makes the most specific route win, always. */
function stubFetch(routes: Record<string, unknown>) {
  const keys = Object.keys(routes).sort((a, b) => b.length - a.length);
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    const key = keys.find((k) => u.includes(k));
    return { ok: true, status: 200, headers: { get: () => 'application/json' }, json: async () => (key ? routes[key] : []) };
  }));
}
function wrap(node: React.ReactNode, entries: string[] = ['/']) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<MemoryRouter initialEntries={entries}><QueryClientProvider client={qc}>{node}</QueryClientProvider></MemoryRouter>);
}

const DERIVED = 'run1_0123456789abcdef0123456789abcdef';
const metricsRun = (over: Record<string, unknown>) => ({
  runId: DERIVED, status: 'completed', modelSteps: 1, toolCalls: 0,
  startTs: 1_700_000_000_000, durationMs: 500, costUsd: 0.001, totalTokens: 10, ...over,
});

describe('Observability — the WORK KEY column appears only where there is work to name', () => {
  it('no run declared one → the column is absent entirely (not a column of dashes)', async () => {
    stubFetch({
      '/metrics/runs': { runs: [metricsRun({ runId: 'plain-1' })] },
      '/metrics': { total: 1, byStatus: { completed: 1 }, costUsd: 0.001, tokens: 10 },
      '/capabilities': CAPS,
      '/runs': [],
    });
    wrap(<Observability />);
    await waitFor(() => expect(screen.getByText('plain-1')).toBeTruthy());
    expect(screen.queryByText(enObs.colWorkKey), 'an empty column still teaches the reader the field exists and is broken').toBeNull();
  });

  it('one run declared one → the column appears, the declared name is readable, and the runs without one say so', async () => {
    stubFetch({
      '/metrics/runs': {
        runs: [
          metricsRun({ runId: DERIVED, workKey: 'invoice-2026-04' }),
          metricsRun({ runId: 'plain-1', startTs: 1_700_000_100_000 }),
        ],
      },
      '/metrics': { total: 2, byStatus: { completed: 2 }, costUsd: 0.002, tokens: 20 },
      '/capabilities': CAPS,
      '/runs': [],
    });
    wrap(<Observability />);
    await waitFor(() => expect(screen.getByText(DERIVED)).toBeTruthy());
    expect(screen.getByText(enObs.colWorkKey)).toBeTruthy();
    expect(screen.getByText('invoice-2026-04')).toBeTruthy();
  });

  it('an execution-axis id keeps its `#` suffix in the text AND percent-encodes it into the run link', async () => {
    // `#2` is the SECOND deliberate execution of the same work — a different run with the same
    // workKey. Dropping the suffix from the link lands the operator on execution #1 and says nothing.
    const second = `${DERIVED}#2`;
    stubFetch({
      '/metrics/runs': { runs: [metricsRun({ runId: second, workKey: 'nightly-reconciliation' })] },
      '/metrics': { total: 1, byStatus: { completed: 1 }, costUsd: 0.001, tokens: 10 },
      '/capabilities': CAPS,
      '/runs': [],
    });
    wrap(<Observability />);
    const link = await screen.findByText(second);
    expect(link.getAttribute('href')).toBe(`/inspector?run=${encodeURIComponent(second)}`);
    expect(link.getAttribute('href')).toContain('%232');
    // The two ids that share this base are told apart by the suffix, never by the workKey — both
    // executions carry the SAME declared name, which is the whole point of the axis.
    expect(screen.getByText('nightly-reconciliation')).toBeTruthy();
  });
});

describe('runsToCsv — the export carries the same column the table does, on the same condition', () => {
  const row = (over: Record<string, unknown>) => ({
    runId: 'r1', status: 'completed', modelSteps: 1, toolCalls: 0,
    startTs: 1, durationMs: 2, costUsd: 0.5, totalTokens: 3, ...over,
  }) as never;

  it('no workKey anywhere → the header is unchanged, byte for byte', () => {
    const csv = runsToCsv([row({})]);
    expect(csv.split('\n')[0]).toBe('runId,status,startTs,durationMs,modelSteps,toolCalls,totalTokens,costUsd');
  });

  it('one row has one → the column is added for every row, and an absent one is empty rather than "undefined"', () => {
    const csv = runsToCsv([row({ workKey: 'invoice-1' }), row({ runId: 'r2' })]);
    const [header, first, second] = csv.split('\n');
    expect(header).toBe('runId,workKey,status,startTs,durationMs,modelSteps,toolCalls,totalTokens,costUsd');
    expect(first).toContain('r1,invoice-1,');
    expect(second).toContain('r2,,');
  });

  it('a workKey holding a comma is quoted, not silently split into two columns', () => {
    expect(runsToCsv([row({ workKey: 'batch,2026' })])).toContain('"batch,2026"');
  });
});

describe('Inspector — the detail header names the work, and hands over the id a human cannot retype', () => {
  const inspectorFetch = (runId: string, workKey?: string) => stubFetch({
    '/capabilities': CAPS,
    '/runs?limit=50': { items: [{ runId, status: 'completed', modelSteps: 1, toolCalls: 0, ...(workKey ? { workKey } : {}) }], total: 1 },
    '/scores': { scores: {} },
    '/trace': { spans: [], totalMs: 0, cost: { costUsd: 0.001, totalTokens: 10, inputTokens: 5, outputTokens: 5 } },
    '/incidents': { incidents: [] },
  });

  it('a declared workKey shows next to the opaque id; a run without one adds no badge', async () => {
    inspectorFetch(DERIVED, 'device-7742-firmware');
    wrap(<Inspector />, [`/inspector?run=${encodeURIComponent(DERIVED)}`]);
    const label = enIns.workKeyBadge.replace('{{workKey}}', 'device-7742-firmware');
    await waitFor(() => expect(screen.getByText(label)).toBeTruthy());

    cleanup();
    inspectorFetch('plain-1');
    wrap(<Inspector />, ['/inspector?run=plain-1']);
    await waitFor(() => expect(screen.getAllByText('plain-1').length).toBeGreaterThan(0));
    expect(screen.queryByText(noBadge(enIns.workKeyBadge))).toBeNull();
  });

  it('the copy control puts the FULL run id on the clipboard — suffix included', async () => {
    // Not the workKey: the caller already knows their own name for the job. What nobody can retype
    // off a screen is `run1_<32 hex>#fork-1`, and that is the string every CLI call, log grep and
    // support ticket needs.
    const forked = `${DERIVED}#fork-1`;
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    inspectorFetch(forked, 'invoice-2026-04');
    wrap(<Inspector />, [`/inspector?run=${encodeURIComponent(forked)}`]);
    const btn = await screen.findByTitle(enIns.copyRunIdTitle);
    fireEvent.click(btn);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(forked));
  });
});

describe('Approvals — the inbox says WHOSE work it is and WHICH work it is', () => {
  const show = (items: unknown[]) => {
    stubFetch({ '/approvals': { items }, '/capabilities': { ...CAPS, approvals: true } });
    wrap(<Approvals />);
  };

  it('the workKey rides beside the owner badge, and neither replaces the other', async () => {
    show([{ runId: DERIVED, toolCallId: 'call-1', toolName: 'chargeCard', owner: 'u-ayse', workKey: 'invoice-2026-04' }]);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());
    expect(screen.getByText(enApr.ownerBadge.replace('{{owner}}', 'u-ayse'))).toBeTruthy();
    expect(screen.getByText(enApr.workKeyBadge.replace('{{workKey}}', 'invoice-2026-04'))).toBeTruthy();
  });

  it('org work with no declared name adds no badge — the row stays as bare as it always was', async () => {
    show([{ runId: 'sus-2', toolCallId: 'call-2', toolName: 'chargeCard' }]);
    await waitFor(() => expect(screen.getByText('chargeCard')).toBeTruthy());
    expect(screen.queryByText(noBadge(enApr.workKeyBadge))).toBeNull();
  });

  it('a `#replay-0` id reaches the Inspector whole', async () => {
    const replayed = `${DERIVED}#replay-0`;
    show([{ runId: replayed, toolCallId: 'call-3', toolName: 'chargeCard', workKey: 'invoice-2026-04' }]);
    const link = await screen.findByText(replayed);
    expect(link.closest('a')!.getAttribute('href')).toBe(`/inspector?run=${encodeURIComponent(replayed)}`);
  });
});
