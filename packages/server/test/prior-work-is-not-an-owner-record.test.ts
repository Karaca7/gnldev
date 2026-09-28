// "Is there work under this run already?" — asked by the replay header (`X-Gnl-Idempotency-Status`)
// and by the budget gate (a continuation is exempt, new work is not).
//
// Since ADR-0002 every run birth writes its owner record FIRST (`claimRunOwner`). So "a `:input`
// record exists" stopped meaning "work exists": a run born and failed before it froze its input has a
// record and nothing else, and the engine runs its retry as a FIRST run (`__gnlPriorRun` false). The
// server read the bare record as prior work: the generate door answered `replay` where the stream door
// answered `new` for the same state, and the budget gate waved the retry through as a "resume" in an
// organization that was over its budget.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, BUDGET_PRE, claimRunOwner, withOrg, user, STAFF, type RawJournal } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';
import { call } from './call.js';

function mkModel(tokens = 10): any {
  const usage = { inputTokens: tokens / 2, outputTokens: tokens / 2, totalTokens: tokens };
  return {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage, warnings: [] }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          c.enqueue({ type: 'text-start', id: '1' });
          c.enqueue({ type: 'text-delta', id: '1', delta: 'ok' });
          c.enqueue({ type: 'text-end', id: '1' });
          c.enqueue({ type: 'finish', finishReason: 'stop', usage });
          c.close();
        },
      }),
    }),
  };
}

const post = (api: any, path: string, body: unknown, org?: string) =>
  call(api, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(org ? { 'x-gnl-org': org } : {}) },
    body: JSON.stringify(body),
  });

function setup() {
  const journal = new InMemoryJournal();
  const api = createRestApi(
    {
      journal,
      agents: { a: { model: mkModel(10) } },
      workflows: {
        w: workflow<unknown>().then(step('s', async () => 'x')).then(waitForResume<{ ok: boolean }>('ok')),
      },
    } as never,
    { org: {}, protectionsBanner: false } as never,
  );
  const acme = withOrg(journal, 'acme') as unknown as RawJournal;
  return { api, journal, acme, overBudget: async () => journal.put(BUDGET_PRE + 'acme', { tokenLimit: 1 }) };
}

describe('an owner record alone is not prior work', () => {
  it('replay header: an agent run born and failed before its input froze is `new` on both doors', async () => {
    const { api, acme } = setup();
    await claimRunOwner(acme, 'born-1', STAFF);
    await claimRunOwner(acme, 'born-2', STAFF);
    const gen = await post(api, '/agents/a/run', { runId: 'born-1', prompt: 'hi' }, 'acme');
    expect(gen.status).toBe(200);
    const str = await post(api, '/agents/a/stream', { runId: 'born-2', prompt: 'hi' }, 'acme');
    expect(str.status).toBe(200);
    await str.text();
    expect(str.headers.get('X-Gnl-Idempotency-Status'), 'the engine itself says: first run').toBe('new');
    expect(gen.headers.get('X-Gnl-Idempotency-Status'), 'the generate door must say what the stream door says').toBe('new');
  });

  it('budget: over budget, the retry of a born-but-empty agent run is new work (402) on both doors', async () => {
    const { api, acme, overBudget } = setup();
    expect((await post(api, '/agents/a/run', { runId: 'spend', prompt: 'hi' }, 'acme')).status).toBe(200);
    await claimRunOwner(acme, 'born-3', STAFF);
    await overBudget();
    expect((await post(api, '/agents/a/run', { runId: 'born-3', prompt: 'hi' }, 'acme')).status).toBe(402);
    expect((await post(api, '/agents/a/stream', { runId: 'born-3', prompt: 'hi' }, 'acme')).status).toBe(402);
  });

  it('budget: over budget, a workflow whose record was written but no step ran is new work (402)', async () => {
    const { api, acme, overBudget } = setup();
    expect((await post(api, '/agents/a/run', { runId: 'spend', prompt: 'hi' }, 'acme')).status).toBe(200);
    await claimRunOwner(acme, 'wf-born', STAFF, { workflow: 'w' });
    await overBudget();
    expect((await post(api, '/workflows/w/run', { runId: 'wf-born', input: {} }, 'acme')).status).toBe(402);
  });

  it("an end user's born record is the same: not prior work", async () => {
    const { api, acme } = setup();
    await claimRunOwner(acme, 'born-u', user('u-1'));
    // Staff re-driving it acts for its recorded owner; the answer is still a first run.
    const gen = await post(api, '/agents/a/run', { runId: 'born-u', prompt: 'hi' }, 'acme');
    expect(gen.status).toBe(200);
    expect(gen.headers.get('X-Gnl-Idempotency-Status')).toBe('new');
  });
});

describe('real prior work keeps its exemption (siblings)', () => {
  it('a completed agent run repeated: `replay`, and exempt from the budget', async () => {
    const { api, overBudget } = setup();
    expect((await post(api, '/agents/a/run', { runId: 'done', prompt: 'hi' }, 'acme')).status).toBe(200);
    await overBudget();
    const again = await post(api, '/agents/a/run', { runId: 'done', prompt: 'hi' }, 'acme');
    expect(again.status).toBe(200);
    expect(again.headers.get('X-Gnl-Idempotency-Status')).toBe('replay');
  });

  it('a suspended workflow resumes over budget', async () => {
    const { api, overBudget } = setup();
    expect((await post(api, '/agents/a/run', { runId: 'spend', prompt: 'hi' }, 'acme')).status).toBe(200);
    expect((await post(api, '/workflows/w/run', { runId: 'wf-s', input: {} }, 'acme')).status).toBe(200);
    await overBudget();
    expect((await post(api, '/workflows/w/run', { runId: 'wf-s', resume: { ok: { ok: true } } }, 'acme')).status).toBe(200);
  });

  it('a brand-new run over budget is refused on every door', async () => {
    const { api, overBudget } = setup();
    expect((await post(api, '/agents/a/run', { runId: 'spend', prompt: 'hi' }, 'acme')).status).toBe(200);
    await overBudget();
    expect((await post(api, '/agents/a/run', { runId: 'fresh', prompt: 'hi' }, 'acme')).status).toBe(402);
    expect((await post(api, '/agents/a/stream', { runId: 'fresh2', prompt: 'hi' }, 'acme')).status).toBe(402);
    expect((await post(api, '/workflows/w/run', { runId: 'fresh3', input: {} }, 'acme')).status).toBe(402);
  });
});
