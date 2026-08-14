// `journal: new SqliteStorage('runs.db').runs` is the FIRST code block in the README, and it was the
// one shape GET /runs could not read.
//
// JournalReader.listRuns() is declared as an array, but every first-party adapter's RunJournal
// (`storage.runs`) returns a Page. `toJournal` bridges the two — and the server only applied it when
// the host passed `storage`. A host that passed `journal` (what the docs teach) got the raw Page, so:
//
//   GET /runs             → {"items":[]} where the route's own contract promises a legacy array
//   GET /runs?limit=2     → 500, `all.filter is not a function`
//   GET /runs?status=…    → 500, same
//
// Not a Postgres-only fault as first reported: it is every persistent adapter, SQLite included.
import { describe, it, expect } from 'vitest';
import { createRestApi } from '../src/index.js';
import { InMemoryStorage } from '@gnldev/durable';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const model = {
  specificationVersion: 'v2', provider: 'scripted', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
  doStream: async () => { throw new Error('generate-only'); },
} as any;

/** A journal in the RunJournal shape — listRuns takes a query and answers with a Page. */
function pagedJournal() {
  const storage = new InMemoryStorage();
  return storage.runs as any; // InMemoryRunJournal.listRuns(q) → Page<RunSummary>, like every adapter
}

async function seed(journal: any, ids: string[]) {
  const { runDurable } = await import('@gnldev/durable');
  for (const runId of ids) await runDurable({ runId, journal, model, prompt: 'x' } as any);
}

describe('GET /runs when the host passes storage.runs as `journal` (the documented quickstart)', () => {
  it('answers a legacy array with no params, and a real page with them', async () => {
    const journal = pagedJournal();
    await seed(journal, ['r1', 'r2', 'r3', 'r4', 'r5']);
    const api = createRestApi({ journal, agents: {} } as any);
    const hit = async (u: string) => {
      const res = await api.fetch(new Request(`http://x${u}`));
      return { status: res.status, body: await res.json() as any };
    };

    const bare = await hit('/runs');
    expect(bare.status).toBe(200);
    expect(Array.isArray(bare.body), 'the no-params route documents a legacy array').toBe(true);
    expect(bare.body).toHaveLength(5);

    const p1 = await hit('/runs?limit=2');
    expect(p1.status, 'this returned 500: all.filter is not a function').toBe(200);
    expect(p1.body.items.map((r: any) => r.runId)).toEqual(['r1', 'r2']);

    // The cursor must actually advance — a page that always returns the first slice is worse than a 500.
    const p2 = await hit(`/runs?limit=2&cursor=${p1.body.nextCursor}`);
    expect(p2.body.items.map((r: any) => r.runId)).toEqual(['r3', 'r4']);

    const filtered = await hit('/runs?status=completed');
    expect(filtered.status).toBe(200);
    expect(filtered.body.items).toHaveLength(5);
    expect((await hit('/runs?status=suspended')).body.items).toHaveLength(0);
  });
});

describe('the org view over a paged journal', () => {
  it('scopes runs instead of throwing on the Page shape', async () => {
    const { withOrg, listRunsArray } = await import('@gnldev/durable');
    const journal = pagedJournal();
    const acme = withOrg(journal, 'acme');
    await seed(acme, ['a1', 'a2']);
    await seed(journal, ['loose']);

    // withOrg's listRuns bridge called .filter on the result — which threw here, taking getOrgUsage
    // (and with it the per-org quota) down with it.
    const scoped = await (acme as any).listRuns();
    expect(scoped.map((r: any) => r.runId).sort()).toEqual(['a1', 'a2']);

    const all = await listRunsArray(journal);
    expect(all.length, 'the unscoped view still sees everything').toBe(3);
  });
});
