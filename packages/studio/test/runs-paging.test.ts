// S4 pagination: GET /runs?limit=&cursor= → a Page envelope (newest first); no parameters → a flat array (backward-compatible).
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import type { RunSummary } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

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

    const p1 = await (await app.request('/runs?limit=2')).json();
    expect(p1.total).toBe(5);
    expect(p1.items.map((r: { runId: string }) => r.runId)).toEqual(['run-5', 'run-4']);
    expect(p1.nextCursor).toBe('2');

    const p2 = await (await app.request(`/runs?limit=2&cursor=${p1.nextCursor}`)).json();
    expect(p2.items.map((r: { runId: string }) => r.runId)).toEqual(['run-3', 'run-2']);
    expect(p2.nextCursor).toBe('4');

    const p3 = await (await app.request(`/runs?limit=2&cursor=${p2.nextCursor}`)).json();
    expect(p3.items.map((r: { runId: string }) => r.runId)).toEqual(['run-1']);
    expect(p3.nextCursor).toBeUndefined(); // last page
  });

  it('page items carry threadId (from the run\'s :input entry); absent if there is none', async () => {
    // For grouping by thread: durable persistInput stamps threadId onto `:input`; /runs reads it.
    const journal = new InMemoryJournal();
    await journal.put('run-1:model:0', { content: [{ type: 'text', text: 'x' }], finishReason: 'stop' });
    await journal.put('run-1:input', { prompt: 'hi', threadId: 'th-9', _v: 1 });
    await journal.put('run-2:model:0', { content: [{ type: 'text', text: 'y' }], finishReason: 'stop' }); // no :input
    const app = createStudioApi({ reader: journal });

    const p = await (await app.request('/runs?limit=10')).json();
    const byId = Object.fromEntries(p.items.map((r: any) => [r.runId, r]));
    expect(byId['run-1'].threadId).toBe('th-9');
    expect(byId['run-2'].threadId).toBeUndefined(); // falls into the ungrouped bucket
  });

  it('a call without parameters returns a backward-compatible flat array', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 3);
    const app = createStudioApi({ reader: journal });
    const res = await (await app.request('/runs')).json();
    expect(Array.isArray(res)).toBe(true);
    expect(res).toHaveLength(3);
  });

  it('malformed limit/cursor values fall back to safe defaults', async () => {
    const journal = new InMemoryJournal();
    await seedRuns(journal, 3);
    const app = createStudioApi({ reader: journal });
    // limit=abc → clamped to a minimum of 1; cursor=-5 → clamped to 0
    const res = await (await app.request('/runs?limit=abc&cursor=-5')).json();
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

      const p1 = await (await app.request('/runs?limit=2')).json();
      expect(p1.items.map((r: RunSummary) => r.runId)).toEqual(['run-5', 'run-4']);
      expect(p1.total).toBe(5);
      expect(p1.nextCursor).toBe('2');

      const p2 = await (await app.request(`/runs?limit=2&cursor=${p1.nextCursor}`)).json();
      expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);
      expect(p2.nextCursor).toBe('4');

      const p3 = await (await app.request(`/runs?limit=2&cursor=${p2.nextCursor}`)).json();
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

      const p1 = await (await app.request('/runs?limit=2')).json();
      expect(p1.items.map((r: RunSummary) => r.runId)).toEqual(['run-5', 'run-4']);
      expect(p1.total).toBe(5);
      expect(p1.nextCursor).toBe('2');

      const p2 = await (await app.request(`/runs?limit=2&cursor=${p1.nextCursor}`)).json();
      expect(p2.items.map((r: RunSummary) => r.runId)).toEqual(['run-3', 'run-2']);
      expect(p2.nextCursor).toBe('4');

      const p3 = await (await app.request(`/runs?limit=2&cursor=${p2.nextCursor}`)).json();
      expect(p3.items.map((r: RunSummary) => r.runId)).toEqual(['run-1']);
      expect(p3.nextCursor).toBeUndefined();

      expect(listSpy).toHaveBeenCalled();
    });
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

      const suspended = await (await app.request('/runs?limit=10&status=suspended')).json();
      expect(suspended.items.map((r: { runId: string }) => r.runId)).toEqual(['run-2']);
      expect(suspended.total).toBe(1);

      const completed = await (await app.request('/runs?limit=10&status=completed')).json();
      expect(completed.items.map((r: { runId: string }) => r.runId).sort()).toEqual(['run-1', 'run-3']);
      expect(completed.total).toBe(2);
    });

    it('an invalid status value is rejected (400), same contract as @gnldev/server', async () => {
      const journal = new InMemoryJournal();
      await seedRuns(journal, 1);
      const app = createStudioApi({ reader: journal });
      const res = await app.request('/runs?limit=10&status=bogus');
      expect(res.status).toBe(400);
    });

    it('q filters by a runId substring, server-side; total reflects the filtered count', async () => {
      const journal = new InMemoryJournal();
      await journal.put('alpha-1:model:0', { content: [{ type: 'text', text: 'a' }], finishReason: 'stop' });
      await journal.put('beta-1:model:0', { content: [{ type: 'text', text: 'b' }], finishReason: 'stop' });
      await journal.put('alpha-2:model:0', { content: [{ type: 'text', text: 'c' }], finishReason: 'stop' });
      const app = createStudioApi({ reader: journal });

      const res = await (await app.request('/runs?limit=10&q=alpha')).json();
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

      const res = await (await app.request('/runs?limit=10&agent=support-bot')).json();
      expect(res.items.map((r: { runId: string }) => r.runId)).toEqual(['run-1']);
      expect(res.total).toBe(1);
    });

    it('a filter param with no limit is ignored — identical to the no-params flat-array contract', async () => {
      const journal = new InMemoryJournal();
      await seedRuns(journal, 3);
      const app = createStudioApi({ reader: journal });
      const res = await (await app.request('/runs?status=suspended')).json();
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

      const res = await (await app.request('/runs?limit=10&status=suspended')).json();
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

      const res = await (await app.request('/runs?limit=10&q=alpha')).json();
      expect(res.items.map((r: { runId: string }) => r.runId)).toEqual(['alpha-1']);
      expect(listSpy).toHaveBeenCalled(); // full scan — confirms the push-down branch is skipped for `q`
    });
  });
});
