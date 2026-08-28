// S4 pagination: GET /runs?limit=&cursor= → a Page envelope (newest first); no parameters → a flat array (backward-compatible).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, purgeRun } from '@gnldev/durable';
import type { RunSummary } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';
import { call } from './call.js';

/** Seeds N ordered runs (journal append order = oldest → newest). */
async function seedRuns(journal: InMemoryJournal, n: number) {
  for (let i = 1; i <= n; i++) {
    await journal.put(`run-${i}:model:0`, { content: [{ type: 'text', text: `answer ${i}` }], finishReason: 'stop' });
  }
}

describe('GET /runs pagination', () => {
  it('returns a Page envelope when limit is given: newest first, nextCursor + total', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 5);
    const app = createStudioApi({ reader: journal });

    const p1 = await (await call(app, '/runs?limit=2')).json();
    expect(p1.total).toBe(5);
    expect(p1.items.map((r: { runId: string }) => r.runId)).toEqual(['run-5', 'run-4']);
    expect(p1.nextCursor).toBeDefined();  // value is encoding, not contract — see the opacity test below

    const p2 = await (await call(app, `/runs?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((r: { runId: string }) => r.runId)).toEqual(['run-3', 'run-2']);
    expect(p2.nextCursor).toBeDefined();

    const p3 = await (await call(app, `/runs?limit=2&cursor=${p2.nextCursor}`)).json();
    expect(p3.items.map((r: { runId: string }) => r.runId)).toEqual(['run-1']);
    expect(p3.nextCursor).toBeUndefined(); // last page
  });

  // The clamp exists because a cursor can outlive the rows it points past: `sweepRuns` deletes old
  // runs, which is the one thing that DOES move an ascending anchor. Without it the route asks the
  // engine for a window beyond the end. Nothing else pins it — remove the clamp and every other test
  // here still passes.
  it('a cursor pointing past the end lands on the first page, not on an empty one', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 3);
    const app = createStudioApi({ reader: journal });

    const far = await (await call(app, '/runs?limit=2&cursor=9999')).json();
    expect(far.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);

    // Zero is a real anchor — "the window ends at the oldest row" — but it is never handed out (the
    // last page reports no cursor at all), so arriving with it means a hand-written or stale request.
    // It is treated as absent for the same reason `-5` is: an empty list is a worse answer than the
    // first page.
    const zero = await (await call(app, '/runs?limit=2&cursor=0')).json();
    expect(zero.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);
  });

  it('page items carry threadId (from the run\'s :input entry); absent if there is none', async () => {
    // For grouping by thread: durable persistInput stamps threadId onto `:input`; /runs reads it.
    const journal = new InMemoryJournal();
    await journal.put('run-1:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
    await journal.put('run-1:input', { prompt: 'hi', threadId: 'th-9', _v: 1 });
    await journal.put('run-2:model:0', { content: [{ type: 'text', text: 'y' }], finishReason: 'stop' }); // no :input
    const app = createStudioApi({ reader: journal });

    const p = await (await call(app, '/runs?limit=10')).json();
    const byId = Object.fromEntries(p.items.map((r: any) => [r.runId, r]));
    expect(byId['run-1'].threadId).toBe('th-9');
    expect(byId['run-2'].threadId).toBeUndefined(); // falls into the ungrouped bucket
  });

  it('a call without parameters returns a backward-compatible flat array', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 3);
    const app = createStudioApi({ reader: journal });
    const res = await (await call(app, '/runs')).json();
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(3);
  });

  it('malformed limit/cursor values fall back to safe defaults', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 3);
    const app = createStudioApi({ reader: journal });
    // limit=abc → clamped to a minimum of 1; cursor=-5 → treated as absent, i.e. the FIRST page.
    // Not "clamped to 0": under the ascending-anchor cursor, 0 is a real position meaning "the window
    // ends at the oldest row", so clamping garbage to it would answer a malformed request with an
    // empty list. See the cursor note in server.ts.
    const res = await (await call(app, '/runs?limit=abc&cursor=-5')).json();
    expect(res.items).toHaveLength(1);
    expect(res.items[0].runId).toBe('run-3');
    expect(res.total).toBe(3);
  });

  // API-01: GET /runs used to call reader.listRuns() (materializing EVERY run) on every ?limit= page
  // request, ignoring the engine's listRunsPaged push-down entirely. These two tests pin the fix:
  // (a) a reader that offers listRunsPaged + countRunsByStatus is queried through the paged capability
  // ONLY (its own listRuns is never touched); (b) a bare reader without the paged capability still
  // produces the exact same newest-first/nextCursor/total result via the legacy scan.
  describe('API-01: listRunsPaged push-down', () => {
    /** A minimal JournalReader whose listRunsPaged/countRunsByStatus are independent of listRuns
     *  (unlike InMemoryJournal's reference impl, which derives both FROM listRuns internally — fine for
     *  an in-memory backend, but it would hide the exact regression this test is pinned against: a real
     *  push-down backend, like Postgres, never calls the array method at all). `items` is in ASCENDING
     *  (oldest → newest) order, mirroring every real adapter's `ORDER BY created_at`. */
    function makePagedReader(items: RunSummary[]) {
      return {
        listRuns: vi.fn(async () => {
          throw new Error('listRuns must not be called when listRunsPaged + countRunsByStatus are both available');
        }),
        readRun: vi.fn(async () => []),
        listRunsPaged: vi.fn(async (q?: { limit?: number; cursor?: string }) => {
          const start = q?.cursor ? Number(q.cursor) : 0;
          const limit = q?.limit ?? 50;
          const page = items.slice(start, start + limit);
          return { items: page, nextCursor: start + limit < items.length ? String(start + limit) : undefined };
        }),
        countRunsByStatus: vi.fn(async () => {
          const out: Record<string, number> = {};
          for (const r of items) out[r.status] = (out[r.status] ?? 0) + 1;
          return out;
        }),
      };
    }
    const fixture: RunSummary[] = Array.from({ length: 5 }, (_, i) => ({
      runId: `run-${i + 1}`,
      status: 'completed' as const,
      steps: 0,
    }));

    it('(a) uses the listRunsPaged push-down (never calls listRuns) and preserves newest-first/nextCursor/total', async () => {
      const reader = makePagedReader(fixture);
      const app = createStudioApi({ reader: reader as any });

      const p1 = await (await call(app, '/runs?limit=2')).json();
      expect(p1.items.map((r: RunSummary) => r.runId)).toEqual(['run-5', 'run-4']);
      expect(p1.total).toBe(5);
      expect(p1.nextCursor).toBeDefined();  // value is encoding, not contract — see the opacity test below

      const p2 = await (await call(app, `/runs?limit=2&cursor=${p1.nextCursor}`)).json();
      expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);
      expect(p2.nextCursor).toBeDefined();

      const p3 = await (await call(app, `/runs?limit=2&cursor=${p2.nextCursor}`)).json();
      expect(p3.items.map((r: RunSummary) => r.runId)).toEqual(['run-1']);
      expect(p3.nextCursor).toBeUndefined();

      expect(reader.listRunsPaged).toHaveBeenCalled();
      expect(reader.countRunsByStatus).toHaveBeenCalled();
      expect(reader.listRuns).not.toHaveBeenCalled();
    });

    it('(b) falls back to the legacy full-scan when listRunsPaged is absent — same result as the push-down path', async () => {
      const journal = new InMemoryJournal();
      await seedRuns(journal, 5);
      // A bare reader (only the mandatory JournalReader methods) — no listRunsPaged/countRunsByStatus,
      // e.g. a custom host-provided JournalReader that never implemented the optional capability.
      const bareReader = { listRuns: journal.listRuns.bind(journal), readRun: journal.readRun.bind(journal) };
      const listSpy = vi.spyOn(bareReader, 'listRuns');
      const app = createStudioApi({ reader: bareReader as any });

      const p1 = await (await call(app, '/runs?limit=2')).json();
      expect(p1.items.map((r: RunSummary) => r.runId)).toEqual(['run-5', 'run-4']);
      expect(p1.total).toBe(5);
      expect(p1.nextCursor).toBeDefined();  // value is encoding, not contract — see the opacity test below

      const p2 = await (await call(app, `/runs?limit=2&cursor=${p1.nextCursor}`)).json();
      expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);
      expect(p2.nextCursor).toBeDefined();

      const p3 = await (await call(app, `/runs?limit=2&cursor=${p2.nextCursor}`)).json();
      expect(p3.items.map((r: RunSummary) => r.runId)).toEqual(['run-1']);
      expect(p3.nextCursor).toBeUndefined();

      expect(listSpy).toHaveBeenCalled();
    });

    // The reason the cursor stopped being a newest-first offset.
    //
    // Runs arrive while somebody is reading. With the offset reading, page 2 recomputed its window
    // from a total that had grown in the meantime — `ascEnd = total - start` — so every insert pushed
    // the window back toward rows the reader had already been shown. Two inserts against a 5-run
    // journal reproduced it exactly: page 2 came back byte-identical to page 1, both runs repeated,
    // and the two rows that should have been on page 2 were never reachable at all. Silent: the
    // envelope is well-formed, the count is right, the rows are real.
    //
    // An ascending anchor cannot drift under an append, because appending does not renumber a row
    // that already exists. Both branches are pinned because a session can start in one and continue
    // in the other (see the cursor note in server.ts).
    it('a run written between page 1 and page 2 does not repeat or skip rows — push-down', async () => {
      const items = [...fixture];
      const app = createStudioApi({ reader: makePagedReader(items) as any });

      const p1 = await (await call(app, '/runs?limit=2')).json();
      expect(p1.items.map((r: RunSummary) => r.runId)).toEqual(['run-5', 'run-4']);

      // Two runs land. `makePagedReader` closes over `items`, so the fake now serves 7.
      items.push({ runId: 'run-6', status: 'completed', steps: 0 } as RunSummary);
      items.push({ runId: 'run-7', status: 'completed', steps: 0 } as RunSummary);

      const p2 = await (await call(app, `/runs?limit=2&cursor=${p1.nextCursor}`)).json();
      expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);
      // The old code returned ['run-5','run-4'] here — the whole of page 1, a second time.
      expect(p2.items.map((r: RunSummary) => r.runId)).not.toEqual(p1.items.map((r: RunSummary) => r.runId));

      const p3 = await (await call(app, `/runs?limit=2&cursor=${p2.nextCursor}`)).json();
      expect(p3.items.map((r: RunSummary) => r.runId)).toEqual(['run-1']);
      expect(p3.nextCursor).toBeUndefined();

      // Every one of the five runs the reader started with was shown exactly once.
      const seen = [p1, p2, p3].flatMap((p) => p.items.map((r: RunSummary) => r.runId));
      expect([...seen].sort()).toEqual(['run-1', 'run-2', 'run-3', 'run-4', 'run-5']);
    });
  });

  // The same drift, down the OTHER branch. This one has to use a bare reader on purpose: an
  // `InMemoryJournal` implements listRunsPaged AND countRunsByStatus, so handing it over would take
  // the push-down branch and quietly re-test the case above under a name that claims otherwise.
  //
  // The branch matters. Under an organization `countRunsByStatus` is deliberately left unbridged
  // (organization.ts) and resolves to undefined, so EVERY org-scoped request lands here — which makes
  // this the path most real multi-tenant traffic takes, not the exotic one.
  it('a run written between page 1 and page 2 does not repeat or skip rows — full-scan fallback', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 5);
    const bareReader = { listRuns: journal.listRuns.bind(journal), readRun: journal.readRun.bind(journal) };
    const app = createStudioApi({ reader: bareReader as any });

    const p1 = await (await call(app, '/runs?limit=2')).json();
    expect(p1.items.map((r: RunSummary) => r.runId)).toEqual(['run-5', 'run-4']);

    await journal.put('run-6:model:0', { content: [{ type: 'text', text: 'answer 6' }], finishReason: 'stop' });
    await journal.put('run-7:model:0', { content: [{ type: 'text', text: 'answer 7' }], finishReason: 'stop' });

    const p2 = await (await call(app, `/runs?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);

    const p3 = await (await call(app, `/runs?limit=2&cursor=${p2.nextCursor}`)).json();
    expect(p3.items.map((r: RunSummary) => r.runId)).toEqual(['run-1']);
    expect(p3.nextCursor).toBeUndefined();

    const seen = [p1, p2, p3].flatMap((p) => p.items.map((r: RunSummary) => r.runId));
    expect([...seen].sort()).toEqual(['run-1', 'run-2', 'run-3', 'run-4', 'run-5']);
  });

  // API-09: GET /runs previously only understood limit/cursor — status/search filtering was left to the
  // client (Inspector.tsx), which only filtered whatever pages were ALREADY loaded and still reported
  // the unfiltered total in the placeholder. These tests pin the server-side contract: status/agent are
  // pushed down (delegated) to listRunsPaged when it's available; q (a runId substring) has no engine
  // push-down and is always applied server-side via the full-scan fallback; `total` always reflects the
  // FILTERED set; no filter params → byte-identical to the pre-API-09 behavior.
  describe('API-09: status/agent/q filters', () => {
    it('status=suspended returns only suspended runs; total reflects the filtered count', async () => {
      const journal = new InMemoryJournal();
      await seedRuns(journal, 3); // run-1..3, all completed
      await journal.put('run-2:tool:0', { status: 'suspended', output: {} }); // run-2 becomes suspended
      const app = createStudioApi({ reader: journal });

      const suspended = await (await call(app, '/runs?limit=10&status=suspended')).json();
      expect(suspended.items.map((r: { runId: string }) => r.runId)).toEqual(['run-2']);
      expect(suspended.total).toBe(1);

      const completed = await (await call(app, '/runs?limit=10&status=completed')).json();
      expect(completed.items.map((r: { runId: string }) => r.runId).sort()).toEqual(['run-1', 'run-3']);
      expect(completed.total).toBe(2);
    });

    it('an invalid status value is rejected (400), same contract as @gnldev/server', async () => {
      const journal = new InMemoryJournal();
      await seedRuns(journal, 1);
      const app = createStudioApi({ reader: journal });
      const res = await call(app, '/runs?limit=10&status=bogus');
      expect(res.status).toBe(400);
    });

    it('q filters by a runId substring, server-side; total reflects the filtered count', async () => {
      const journal = new InMemoryJournal();
      await journal.put('alpha-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
      await journal.put('beta-1:model:0', { content: [{ type: 'text', text: 'b' }], finishReason: 'stop' });
      await journal.put('alpha-2:model:0', { content: [{ type: 'text', text: 'c' }], finishReason: 'stop' });
      const app = createStudioApi({ reader: journal });

      const res = await (await call(app, '/runs?limit=10&q=alpha')).json();
      expect(res.items.map((r: { runId: string }) => r.runId).sort()).toEqual(['alpha-1', 'alpha-2']);
      expect(res.total).toBe(2);
    });

    it("agent filters by the run's registered agent name (from :input, same field GET /runs already surfaces)", async () => {
      const journal = new InMemoryJournal();
      await journal.put('run-1:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
      await journal.put('run-1:input', { prompt: 'hi', agent: 'support-bot', _v: 1 });
      await journal.put('run-2:model:0', { content: [{ type: 'text', text: 'y' }], finishReason: 'stop' });
      await journal.put('run-2:input', { prompt: 'hi', agent: 'billing-bot', _v: 1 });
      const app = createStudioApi({ reader: journal });

      const res = await (await call(app, '/runs?limit=10&agent=support-bot')).json();
      expect(res.items.map((r: { runId: string }) => r.runId)).toEqual(['run-1']);
      expect(res.total).toBe(1);
    });

    it('a filter param with no limit is ignored — identical to the no-params flat-array contract', async () => {
      const journal = new InMemoryJournal();
      await seedRuns(journal, 3);
      const app = createStudioApi({ reader: journal });
      const res = await (await call(app, '/runs?status=suspended')).json();
      expect(Array.isArray(res)).toBe(true);
      expect(res).toHaveLength(3); // status ignored without `limit` — matches today's contract
    });

    it('status is delegated to listRunsPaged (never falls back to listRuns) when the engine supports it', async () => {
      const fixture: RunSummary[] = [
        { runId: 'run-1', status: 'completed', modelSteps: 1, toolCalls: 0 },
        { runId: 'run-2', status: 'suspended', modelSteps: 1, toolCalls: 1 },
        { runId: 'run-3', status: 'completed', modelSteps: 1, toolCalls: 0 },
      ];
      const reader = {
        listRuns: vi.fn(async () => { throw new Error('must not be called — status is push-down-capable'); }),
        readRun: vi.fn(async () => []),
        listRunsPaged: vi.fn(async (q?: { limit?: number; cursor?: string; status?: string }) => {
          const filtered = q?.status ? fixture.filter((r) => r.status === q.status) : fixture;
          const start = q?.cursor ? Number(q.cursor) : 0;
          const limit = q?.limit ?? 50;
          const page = filtered.slice(start, start + limit);
          return { items: page, nextCursor: start + limit < filtered.length ? String(start + limit) : undefined };
        }),
        countRunsByStatus: vi.fn(async () => ({ completed: 2, suspended: 1 })),
      };
      const app = createStudioApi({ reader: reader as any });

      const res = await (await call(app, '/runs?limit=10&status=suspended')).json();
      expect(res.items.map((r: RunSummary) => r.runId)).toEqual(['run-2']);
      expect(res.total).toBe(1);
      expect(reader.listRunsPaged).toHaveBeenCalledWith(expect.objectContaining({ status: 'suspended' }));
      expect(reader.listRuns).not.toHaveBeenCalled();
    });

    it('agent/q filters fall back to the full-scan path even when listRunsPaged is available (no cheap filtered total)', async () => {
      const journal = new InMemoryJournal(); // implements BOTH listRunsPaged and countRunsByStatus
      await journal.put('alpha-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
      await journal.put('beta-1:model:0', { content: [{ type: 'text', text: 'b' }], finishReason: 'stop' });
      const listSpy = vi.spyOn(journal, 'listRuns');
      const app = createStudioApi({ reader: journal });

      const res = await (await call(app, '/runs?limit=10&q=alpha')).json();
      expect(res.items.map((r: { runId: string }) => r.runId)).toEqual(['alpha-1']);
      expect(listSpy).toHaveBeenCalled(); // full scan — confirms the push-down branch is skipped for `q`
    });
  });
});

/**
 * Scenarios contributed by a review round whose job was to find what the tests above do NOT cover.
 * Two measurements from it are worth recording, because they change what "covered" means here:
 *
 *   - Disabling the push-down branch entirely left 13 of 16 tests green. Most of the file cannot
 *     tell which branch ran, so `expect(listSpy).toHaveBeenCalled()` proves nothing: InMemoryJournal
 *     derives BOTH `listRunsPaged` and `countRunsByStatus` from `listRuns`, so the array method is
 *     called on either path. Only a NEGATIVE spy assertion distinguishes them.
 *   - Removing the anchor clamp left 15 of 16 green.
 *
 * The other correction: `createStudioApi` wraps whatever it is handed in `asReaderJournal`, which
 * SYNTHESISES `listRunsPaged`. The real discriminator is `countRunsByStatus`, which is also why an
 * organization-scoped request always takes the full-scan path — `organization.ts` deliberately does
 * not bridge it.
 */
describe('GET /runs — what the coverage above misses', () => {
  const seedPaged = (n: number): RunSummary[] =>
    Array.from({ length: n }, (_, i) => ({ runId: `run-${String(i + 1).padStart(2, '0')}`, status: 'completed' as const, steps: 0 }));

  /** Push-down reader over a MUTABLE array, so a test can delete rows between requests. */
  function pagedOver(items: RunSummary[]) {
    return {
      listRuns: vi.fn(async () => { throw new Error('listRuns must not be called on the push-down path'); }),
      readRun: vi.fn(async () => []),
      listRunsPaged: vi.fn(async (q?: { limit?: number; cursor?: string }) => {
        const start = q?.cursor ? Number(q.cursor) : 0;
        const limit = q?.limit ?? 50;
        return { items: items.slice(start, start + limit), nextCursor: start + limit < items.length ? String(start + limit) : undefined };
      }),
      countRunsByStatus: vi.fn(async () => ({ completed: items.length })),
    };
  }

  /** Walks the whole chain the way a client does: echo the cursor, never look inside it. */
  async function walk(app: any, query: string) {
    const pages: any[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await (await call(app, `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`)).json();
      pages.push(page);
      if (!page.nextCursor) return pages;
      cursor = page.nextCursor;
    }
    throw new Error('pagination did not terminate in 50 pages — the cursor is not advancing');
  }

  /**
   * The contract is "echo the cursor back"; a client that does exactly that must reach the end.
   *
   * Deliberately asserts nothing about the cursor's VALUE. The tests above used to
   * (`expect(nextCursor).toBe('3')`), which pins the encoding rather than the promise — and since
   * the encoding is documented as opaque and is expected to become a `created_at`+`runId` key, those
   * assertions would have turned a correct change red. One test below still pins the encoding, on
   * purpose and under a name that says so.
   */
  it('a client that only echoes the cursor sees every run exactly once', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 12);
    const app = createStudioApi({ reader: journal });

    const pages = await walk(app, '/runs?limit=3');
    const seen = pages.flatMap((p) => p.items.map((r: RunSummary) => r.runId));

    // Three assertions, because each catches something the others do not: the union catches a SKIP,
    // the Set catches a REPEAT, and the count catches a page that quietly served more than `limit`.
    expect([...seen].sort()).toEqual(Array.from({ length: 12 }, (_, i) => `run-${i + 1}`).sort());
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages.every((p) => p.items.length <= 3)).toBe(true);
    expect(pages.at(-1)!.nextCursor).toBeUndefined();
  });

  /**
   * Today's encoding, pinned on purpose and named so nobody mistakes it for the contract.
   *
   * If this fails and the opacity test above still passes, the encoding changed and that is allowed —
   * update this test. If the one above fails too, the change broke pagination itself.
   */
  it('encoding note: the cursor is a numeric string today — that is not a promise', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 5);
    const app = createStudioApi({ reader: journal });
    const p1 = await (await call(app, '/runs?limit=2')).json();
    expect(p1.nextCursor).toMatch(/^\d+$/);
  });

  /**
   * An uninterpretable cursor used to answer 200 with page 1 AND a fresh cursor — measured:
   * `?cursor=k_2026_r5` returned the first page and a cursor of `"2"`. That is the worst possible
   * answer: the Studio's infinite query appends pages without de-duplicating, so a client following
   * a cursor it will never advance past re-appends the same rows for as long as the user keeps
   * clicking. A stale-but-well-formed cursor is a different event and still clamps.
   */
  it('rejects a cursor it cannot interpret instead of silently restarting', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 5);
    const app = createStudioApi({ reader: journal });

    const res = await call(app, '/runs?limit=2&cursor=k_2026_r5');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cursor/i);

    // Well-formed but stale still works — the two cases must not collapse into one another.
    expect((await (await call(app, '/runs?limit=2&cursor=9999')).json()).items).toHaveLength(2);
  });

  /**
   * `total` and the rows are two separate reads. A retention sweep landing between them left the
   * route asking for a window past the end of a table that had just shrunk, and it answered with an
   * empty `items` beside a `total` of 10 — page one of a list that visibly had runs in it.
   */
  it('never answers with an empty page while claiming the list is not empty', async () => {
    const items = seedPaged(10);
    const reader = pagedOver(items);
    // The sweep happens between the count and the page read: `countRunsByStatus` reports the table
    // as it was, then removes six rows before `listRunsPaged` runs.
    reader.countRunsByStatus.mockImplementationOnce(async () => {
      const before = { completed: items.length };
      items.splice(0, 6);
      return before;
    });
    const app = createStudioApi({ reader: reader as any });

    const p = await (await call(app, '/runs?limit=3')).json();
    expect(p.total).toBeGreaterThan(0);
    expect(p.items.length).toBeGreaterThan(0);
  });

  /**
   * Deleting the oldest runs mid-session moves an ascending anchor — the acknowledged cost of the
   * cursor change (see the note in server.ts). What must NOT happen is a run going missing: repeats
   * are recoverable by scrolling, a row never shown is not.
   */
  it('a retention purge between pages may repeat rows, but never hides a surviving one', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 10);
    const app = createStudioApi({ reader: journal });

    const p1 = await (await call(app, '/runs?limit=3')).json();
    for (let i = 1; i <= 6; i++) await purgeRun(journal, `run-${i}`);

    const rest = await walk(app, `/runs?limit=3&_=1`); // fresh walk after the purge
    const seen = [...p1.items, ...rest.flatMap((p) => p.items)].map((r: RunSummary) => r.runId);
    for (const survivor of ['run-7', 'run-8', 'run-9', 'run-10']) {
      expect(seen, `${survivor} survived the purge and must still be reachable`).toContain(survivor);
    }
  });

  /**
   * Which branch ran, asserted the only way that actually distinguishes them.
   *
   * `expect(listRuns).toHaveBeenCalled()` is true on BOTH paths with an InMemoryJournal, because its
   * paged and counting methods are implemented over the array one. A negative assertion is the only
   * honest form.
   */
  it('an adapter without a cheap status count takes the full-scan path, not the push-down', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 6);
    // Everything the push-down needs EXCEPT the count — which is the real discriminator, and exactly
    // the shape Redis and every organization-scoped view present.
    const noCount = {
      listRuns: journal.listRuns.bind(journal),
      readRun: journal.readRun.bind(journal),
      listRunsPaged: vi.fn(journal.listRunsPaged.bind(journal)),
    };
    const app = createStudioApi({ reader: noCount as any });

    const pages = await walk(app, '/runs?limit=2');
    expect(noCount.listRunsPaged).not.toHaveBeenCalled();
    expect(pages.flatMap((p) => p.items.map((r: RunSummary) => r.runId))).toHaveLength(6);
  });
});
