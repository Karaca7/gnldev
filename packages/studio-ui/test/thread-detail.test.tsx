// @vitest-environment jsdom
// ThreadDetail (inspector-thread.tsx) — the thread ledger + per-turn memory provenance panel.
// Pins: turns render oldest-first with mono numbers and aggregates; expanding a turn's Memory row
// lazily fetches GET /runs/:id/memory-context and renders recall hits WITH their similarity; a
// missing record renders the honest "no provenance" note, never an error.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import '../src/i18n';
import { ThreadDetail } from '../src/views/inspector-thread';
import type { MetricsRun, RunSummary } from '../src/api';

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function stubFetch(routes: Record<string, unknown>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const u = String(url);
    calls.push(u);
    const key = Object.keys(routes).find((k) => u.endsWith(k));
    return {
      ok: true, status: 200,
      headers: { get: () => 'application/json' },
      json: async () => (key ? routes[key] : { context: null }),
    };
  }));
  return calls;
}

// The left list serves runs newest-first; the ledger must show turn #1 first.
const RUNS: RunSummary[] = [
  { runId: 'r-2', status: 'completed', modelSteps: 1, toolCalls: 0, threadId: 'th-1' },
  { runId: 'r-1', status: 'completed', modelSteps: 1, toolCalls: 0, threadId: 'th-1' },
];
const METRICS = new Map<string, MetricsRun>([
  ['r-1', { runId: 'r-1', status: 'completed', modelSteps: 1, toolCalls: 0, startTs: 1, durationMs: 1200, costUsd: 0.01, totalTokens: 10 }],
  ['r-2', { runId: 'r-2', status: 'completed', modelSteps: 1, toolCalls: 0, startTs: 2, durationMs: 800, costUsd: 0.02, totalTokens: 20 }],
]);

function wrap(el: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{el}</QueryClientProvider>);
}

describe('ThreadDetail', () => {
  it('renders the ledger oldest-first with aggregates; expanding Memory fetches provenance lazily', async () => {
    const calls = stubFetch({
      '/threads/th-1/messages': [],
      '/runs/r-1/memory-context': {
        context: {
          v: 1, threadId: 'th-1',
          recalled: [{ threadId: 'th-1', seq: 4, role: 'user', preview: 'refund policy…', score: 0.87 }],
          recent: [
            { threadId: 'th-1', seq: 11, role: 'user', preview: 'previous question' },
            { threadId: 'th-1', seq: 12, role: 'assistant', preview: 'previous answer' },
          ],
          recentCount: 6, workingMemoryChars: 42, incomingCount: 1, echoTrimmed: 2,
        },
      },
    });
    wrap(<ThreadDetail threadId="th-1" title="Refund chat" runs={RUNS} metricsById={METRICS} onOpenRun={() => {}} />);

    expect(screen.getByText('Refund chat')).toBeTruthy();
    expect(screen.getByText('2 turns')).toBeTruthy();
    expect(screen.getByText('$0.0300')).toBeTruthy(); // cumulative cost
    // Ledger order: #1 = the OLDER run (r-1).
    const rows = screen.getAllByTitle("Open this turn's run detail").map((b) => b.textContent);
    expect(rows).toEqual(['r-1', 'r-2']);
    // Lazy: nothing fetched until a Memory row is expanded.
    expect(calls.filter((u) => u.includes('memory-context'))).toHaveLength(0);

    fireEvent.click(screen.getAllByText('memory')[0]!);
    await waitFor(() => expect(screen.getByText(/refund policy/)).toBeTruthy());
    expect(screen.getByText('0.87')).toBeTruthy(); // the similarity score, surfaced at last
    expect(screen.getByText(/6 messages from the recent window/)).toBeTruthy();
    // The window ITSELF is listed ref-by-ref (the "what went to the model" half)…
    expect(screen.getByText(/previous question/)).toBeTruthy();
    expect(screen.getByText(/previous answer/)).toBeTruthy();
    // …and the cap gap is stated honestly (recentCount 6, refs 2 → 4 more).
    expect(screen.getByText(/4 more/)).toBeTruthy();
    expect(screen.getByText(/42 chars/)).toBeTruthy();
    expect(screen.getByText(/2 client-echoed messages trimmed/)).toBeTruthy();
    expect(calls.filter((u) => u.includes('/runs/r-1/memory-context'))).toHaveLength(1);
  });

  it('ghost turns: an unanswered question (no run) appears as a faded row between the real turns', async () => {
    stubFetch({
      '/threads/th-1/messages': [
        { role: 'user', content: 'first try — died before the model' }, // ← next is ALSO user → ghost
        { role: 'user', content: 'first try, resent' },
        { role: 'assistant', content: [{ type: 'text', text: 'answer 1' }] },
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: [{ type: 'text', text: 'answer 2' }] },
      ],
    });
    wrap(<ThreadDetail threadId="th-1" title="Ghost chat" runs={RUNS} metricsById={METRICS} onOpenRun={() => {}} />);

    await waitFor(() => expect(screen.getByText(/first try — died before the model/)).toBeTruthy());
    expect(screen.getByText('unanswered')).toBeTruthy();
    expect(screen.getByText('1 unanswered')).toBeTruthy(); // header chip
    // Turn numbering skips ghosts: the two real runs are still #1/#2, in order.
    const rows = screen.getAllByTitle("Open this turn's run detail").map((b) => b.textContent);
    expect(rows).toEqual(['r-1', 'r-2']);
  });

  it('structural mismatch (seeded/multi-message history) falls back to the runs-only ledger', async () => {
    stubFetch({
      '/threads/th-1/messages': [
        { role: 'user', content: 'q1' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
        { role: 'assistant', content: 'a2' },
        { role: 'user', content: 'q3' },
        { role: 'assistant', content: 'a3' }, // 3 answered clusters, only 2 runs → don't guess
      ],
    });
    wrap(<ThreadDetail threadId="th-1" runs={RUNS} metricsById={METRICS} onOpenRun={() => {}} />);
    await waitFor(() => expect(screen.getAllByTitle("Open this turn's run detail")).toHaveLength(2));
    expect(screen.queryByText('unanswered')).toBeNull();
  });

  it('no provenance record → honest note, not an error; clicking a turn opens its run', async () => {
    stubFetch({ '/runs/r-2/memory-context': { context: null } });
    const opened: string[] = [];
    wrap(<ThreadDetail threadId="th-1" runs={RUNS} metricsById={METRICS} onOpenRun={(id) => opened.push(id)} />);

    // Untitled thread → mono id as the heading.
    expect(screen.getAllByText('th-1').length).toBeGreaterThan(0);
    fireEvent.click(screen.getAllByText('memory')[1]!); // turn #2 = r-2
    await waitFor(() => expect(screen.getByText(/No memory provenance recorded/)).toBeTruthy());

    fireEvent.click(screen.getByText('r-1'));
    expect(opened).toEqual(['r-1']);
  });

  /**
   * The two memory-context fields @gnldev/durable stamps when a turn's input could not be preserved.
   * These are the only silent losses in the whole memory path: the run itself completes, the answer
   * is stored, and nothing else in the UI would ever say the question is missing.
   */
  it('incomingUnrecoverable is surfaced as an ALARM, with the SDK reason and what it means', async () => {
    stubFetch({
      '/threads/th-1/messages': [],
      '/runs/r-1/memory-context': {
        context: {
          v: 1, threadId: 'th-1', recalled: [], recentCount: 3,
          // The count the durable side forces to 0 when it reports a loss — an answer with no question.
          incomingCount: 0, echoTrimmed: 0, incomingUnrecoverable: 'boundary-lost',
        },
      },
    });
    wrap(<ThreadDetail threadId="th-1" runs={RUNS} metricsById={METRICS} onOpenRun={() => {}} />);

    fireEvent.click(screen.getAllByText('memory')[0]!);
    await waitFor(() => expect(screen.getByText(/no recoverable copy of this turn/i)).toBeTruthy());
    // The raw enum is kept verbatim: it is the SDK's own vocabulary and what an operator greps for.
    expect(screen.getByText('boundary-lost')).toBeTruthy();
    // …and it is explained, so the enum is not the whole message.
    expect(screen.getByText(/rebuilt every message/i)).toBeTruthy();
    // It is an alert, not a quiet provenance line — double-coded, so this does not rest on colour.
    expect(screen.getByRole('status')).toBeTruthy();
  });

  it('incomingDedupedByShape is a NEUTRAL note — it can cost a turn count, never content', async () => {
    stubFetch({
      '/threads/th-1/messages': [],
      '/runs/r-1/memory-context': {
        context: {
          v: 1, threadId: 'th-1', recalled: [], recentCount: 3,
          incomingCount: 1, echoTrimmed: 0, incomingDedupedByShape: true,
        },
      },
    });
    wrap(<ThreadDetail threadId="th-1" runs={RUNS} metricsById={METRICS} onOpenRun={() => {}} />);

    fireEvent.click(screen.getAllByText('memory')[0]!);
    await waitFor(() => expect(screen.getByText(/deduplicated on the masked shapes/i)).toBeTruthy());
    expect(screen.getByText('dedupe')).toBeTruthy();
    // NOT an alert: nothing was lost but a count, and crying wolf here would devalue the row above.
    expect(screen.queryByRole('status'), 'a dedupe note was raised to the same level as a data loss').toBeNull();
  });

  it('a healthy record shows neither row', async () => {
    stubFetch({
      '/threads/th-1/messages': [],
      '/runs/r-1/memory-context': {
        context: { v: 1, threadId: 'th-1', recalled: [], recentCount: 3, incomingCount: 1, echoTrimmed: 0 },
      },
    });
    wrap(<ThreadDetail threadId="th-1" runs={RUNS} metricsById={METRICS} onOpenRun={() => {}} />);

    fireEvent.click(screen.getAllByText('memory')[0]!);
    await waitFor(() => expect(screen.getByText(/3 messages from the recent window/)).toBeTruthy());
    expect(screen.queryByRole('status')).toBeNull();
    expect(screen.queryByText('dedupe')).toBeNull();
  });
});
