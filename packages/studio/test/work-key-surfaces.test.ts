// PAKET #6 — the two Studio endpoints that had a runId column and no way to say what the run WAS.
//
// A derived runId is `run1_<32 hex>`. Everything readable about a run left the id when package #3
// landed and moved into one field on the run's record (`:input.workKey`, package #2). `GET /runs`
// already carried it for free — `listRuns` reads that same blob and RunSummary has the field — but
// the two endpoints built on top of it dropped it on the floor:
//
//   /metrics/runs   builds its own row shape (materialized fast path + scan fallback) and simply
//                   listed no such field, on either path.
//   /approvals      point-reads `<runId>:input` for the owner and read exactly two keys out of it.
//
// Which meant the Observability table and the approval inbox were the two screens where an operator
// saw nothing but hashes. Both are pinned here, and both paths of /metrics/runs are, because a fix
// applied to only one of them fails exactly when the metrics row happens to exist.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, stampFormat } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

const drive = (api: unknown) => api as (r: Request) => Promise<Response>;
const DERIVED = 'run1_0123456789abcdef0123456789abcdef';

/** A finished run with a model step, plus the invisible `:input` entry durable freezes for it. */
async function seedRun(journal: InMemoryJournal, runId: string, input: Record<string, unknown>) {
  await journal.put(`${runId}:input`, stampFormat({ at: 1, prompt: 'go', ...input }));
  await journal.put(`${runId}:model:0`, stampFormat({ text: 'ok', finishReason: 'stop' }));
}

describe('GET /runs — already carried it, and must keep doing so on both shapes', () => {
  // Nothing was changed here: the route returns `reader.listRuns()` verbatim, and RunSummary grew
  // the field in package #2. Pinned anyway, because it is the query the Inspector's header reads
  // from — a future hand-built row shape on this route would silently blank that badge.
  it('the flat array and the paged envelope both surface the declared workKey', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, DERIVED, { workKey: 'invoice-2026-04', agent: 'billing' });
    const api = drive(createStudioApi({ reader: journal }));

    const flat = await (await api(new Request('http://s/runs'))).json() as Array<{ runId: string; workKey?: string }>;
    expect(flat.find((r) => r.runId === DERIVED)?.workKey).toBe('invoice-2026-04');

    const paged = await (await api(new Request('http://s/runs?limit=50'))).json() as { items: Array<{ runId: string; workKey?: string }> };
    expect(paged.items.find((r) => r.runId === DERIVED)?.workKey).toBe('invoice-2026-04');
  });
});

describe('GET /metrics/runs — the row says which work it measured', () => {
  it('the SCAN path (no materialized row) carries the declared workKey', async () => {
    const journal = new InMemoryJournal();
    await seedRun(journal, DERIVED, { workKey: 'invoice-2026-04', workScope: { kind: 'resource', value: 'u-142' } });
    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/metrics/runs'))).json() as { runs: Array<{ runId: string; workKey?: string }> };
    expect(body.runs.find((r) => r.runId === DERIVED)?.workKey).toBe('invoice-2026-04');
  });

  it('the MATERIALIZED path carries it too — the fast row is about cost, the name is not cost', async () => {
    // `__metrics__run:<runId>` is written once when a run finishes and holds tokens/duration/spend.
    // The workKey is deliberately NOT copied into it (it would be a second home for a fact that
    // already has one); it comes off the RunSummary this handler already fetched. Which is exactly
    // why this needs its own test: the two paths build two different objects.
    const journal = new InMemoryJournal();
    await seedRun(journal, DERIVED, { workKey: 'nightly-reconciliation' });
    await journal.put(`__metrics__run:${DERIVED}`, {
      modelSteps: 1, toolCalls: 0, startTs: 1_700_000_000_000, durationMs: 500, costUsd: 0.01, totalTokens: 42, status: 'completed',
    });
    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/metrics/runs'))).json() as { runs: Array<{ runId: string; workKey?: string; totalTokens: number }> };
    const row = body.runs.find((r) => r.runId === DERIVED)!;
    expect(row.totalTokens, 'the fixture must actually hit the fast path, or this asserts nothing').toBe(42);
    expect(row.workKey).toBe('nightly-reconciliation');
  });

  it('a run whose caller never declared one carries NO field — absent, not an empty string', async () => {
    // The conditional column in studio-ui keys off exactly this: `undefined` means "nobody here
    // names work" and hides the column; `''` would make it appear, permanently blank.
    const journal = new InMemoryJournal();
    await seedRun(journal, 'plain-1', {});
    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/metrics/runs'))).json() as { runs: Array<{ runId: string; workKey?: string }> };
    expect('workKey' in body.runs.find((r) => r.runId === 'plain-1')!).toBe(false);
  });

  it('…and it is still absent on the MATERIALIZED path — the presence test above has two paths, so this must too', async () => {
    // The absence check only ever ran on the SCAN path, while the presence check runs on both. That
    // asymmetry is the gap: the two paths build two different objects (see the note above), so
    // "hides the column when nobody declares work" was verified for one of them and assumed for the
    // other — and the fast row is the one a real deployment reads, because it is written the moment
    // a run finishes.
    const journal = new InMemoryJournal();
    await seedRun(journal, 'plain-2', {});
    await journal.put('__metrics__run:plain-2', {
      modelSteps: 1, toolCalls: 0, startTs: 1_700_000_000_000, durationMs: 500, costUsd: 0.01, totalTokens: 77, status: 'completed',
    });
    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/metrics/runs'))).json() as { runs: Array<{ runId: string; workKey?: string; totalTokens: number }> };
    const row = body.runs.find((r) => r.runId === 'plain-2')!;
    expect(row.totalTokens, 'the fixture must actually hit the fast path, or this asserts nothing').toBe(77);
    expect('workKey' in row).toBe(false);
  });
});

describe('GET /approvals — the inbox row says WHICH work the question is about', () => {
  async function seedSuspend(journal: InMemoryJournal, runId: string, input: Record<string, unknown>) {
    const sentinel = { __gnl_suspend: { toolCallId: 'call-1', toolName: 'chargeCard', args: { amount: 20 }, reason: 'approve to charge' } };
    await journal.put(`${runId}:input`, stampFormat({ at: 1, prompt: 'go', ...input }));
    await journal.put(`${runId}:tool:call-1`, stampFormat({ status: 'suspended', output: sentinel, toolName: 'chargeCard' }));
  }

  it('the workKey rides alongside the owner, out of the same frozen `:input`', async () => {
    const journal = new InMemoryJournal();
    await seedSuspend(journal, DERIVED, { resourceId: 'u-142', actor: 'ayse', workKey: 'invoice-2026-04' });
    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/approvals'))).json() as { items: Array<{ runId: string; owner?: string; ownerActor?: string; workKey?: string }> };
    const row = body.items.find((i) => i.runId === DERIVED)!;
    expect(row.owner).toBe('u-142');
    expect(row.ownerActor, 'the two ownership fields must not have been disturbed').toBe('ayse');
    expect(row.workKey).toBe('invoice-2026-04');
  });

  it('org work with no declared name gets no field at all', async () => {
    const journal = new InMemoryJournal();
    await seedSuspend(journal, 'batch:aylik-1:F-1', {});
    const api = drive(createStudioApi({ reader: journal }));
    const body = await (await api(new Request('http://s/approvals'))).json() as { items: Array<{ runId: string; workKey?: string }> };
    expect('workKey' in body.items.find((i) => i.runId === 'batch:aylik-1:F-1')!).toBe(false);
  });

  it('a read-only journal still labels the row — the summary is the source, the point-read only the fallback', async () => {
    // `listRuns` surfaces workKey from `:input` on its own, so a reader with no `get` (a custom
    // JournalReader, an org-scoped view) keeps the label. The ownership fields degrade here — that
    // is the documented fail-open side of the lock — but the operator can still tell the rows apart.
    const journal = new InMemoryJournal();
    await seedSuspend(journal, DERIVED, { resourceId: 'u-142', actor: 'ayse', workKey: 'invoice-2026-04' });
    const readOnly = { listRuns: () => journal.listRuns(), readRun: (id: string) => journal.readRun(id) };
    const api = drive(createStudioApi({ reader: readOnly as never }));
    const body = await (await api(new Request('http://s/approvals'))).json() as { items: Array<{ runId: string; workKey?: string; ownerActor?: string }> };
    const row = body.items.find((i) => i.runId === DERIVED)!;
    expect(row.workKey).toBe('invoice-2026-04');
    expect(row.ownerActor).toBeUndefined();
  });
});
