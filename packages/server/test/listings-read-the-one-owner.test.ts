// Every listing a caller filters to ONE user answers "whose is this row" the way the run gates do:
// `runOwnerOf` + `decideRunAccess` (ADR-0002 point 3). A row the gates would refuse that user is not
// in that user's list.
//
// M5 (the ADR's open mutation): `GET /workflows/runs` read the owner itself, from the raw
// `resourceId` field of `<runId>:input`, and a mutation that let an ownerless row into a user's list
// (`owner === resourceId || owner === undefined`) failed no test in the suite. It was masked for an
// end user by the subject view, and nothing asked the path the view does not cover: staff filtering
// by a user (`?resourceId=`). The same hand reading also skipped the `_v` rule, so an unstamped record
// naming Ayşe — which every gate reads as staff's — was listed as hers.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, createGnl } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';

const model = {
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
};
const PRINCIPALS: Record<string, unknown> = {
  ayse: { kind: 'subject', id: 'u-ayse', roles: ['admin'] },
  ops: { kind: 'operator', id: 'ops', roles: ['admin'] },
  app: { kind: 'application', id: 'app', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
};

async function setup() {
  const storage = new InMemoryStorage();
  // A memory that records a thread's owner the way the storage-backed ones do: on the first turn
  // that names a user. A staff turn names nobody, so its thread has no owner record.
  const threads = new Map<string, string>();
  const memory = {
    loadContext: async (t: string, o?: { resourceId?: string }) => { if (o?.resourceId) threads.set(t, o.resourceId); return { messages: [] as unknown[] }; },
    append: async () => {},
    getMessages: async () => [],
    getThreadResource: async (t: string) => threads.get(t),
    listThreads: async (o: { resourceId: string }) => [...threads].filter(([, r]) => r === o.resourceId).map(([id, r]) => ({ id, resourceId: r })),
    listAllThreads: async () => [...threads].map(([id, r]) => ({ id, resourceId: r })),
  };
  const config = {
    storage, memoryFactory: () => memory,
    agents: { a: { model } },
    workflows: { w: workflow<unknown>().then(step('s', async () => 'x')).then(waitForResume<{ ok: boolean }>('ok')) },
  } as any;
  const api = createRestApi(config, { auth: auth as never, protectionsBanner: false });
  const call = async (who: string, path: string, body?: unknown) => {
    const r = await api(new Request(`http://x${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: r.status, body: await r.text() };
  };
  const journal = storage.runs as any;
  return { config, call, journal };
}

/** Ayşe's row, and every kind of row that is NOT hers although a hand reading could think so. */
async function seedWorkflows() {
  const s = await setup();
  const { call, journal, config } = s;
  expect((await call('ayse', '/workflows/w/run', { runId: 'wf-ayse', input: {} })).status).toBe(200);
  // ownerless: staff's own work
  expect((await call('ops', '/workflows/w/run', { runId: 'wf-staff', input: {} })).status).toBe(200);
  // born with no caller at all
  await createGnl(config).runWorkflow('w', {}, { runId: 'wf-unknown' });
  // record gone, rows present: the gates read it as staff's
  expect((await call('ayse', '/workflows/w/run', { runId: 'wf-legacy', input: {} })).status).toBe(200);
  await journal.deletePrefix('wf-legacy:input');
  // an UNSTAMPED record naming Ayşe (a caller's bytes, not an owner): the gates read it as staff's
  expect((await call('ops', '/workflows/w/run', { runId: 'wf-unstamped', input: {} })).status).toBe(200);
  await journal.put('wf-unstamped:input', { resourceId: 'u-ayse', workflow: 'w' });
  return s;
}
const NOT_HERS = ['wf-staff', 'wf-unknown', 'wf-legacy', 'wf-unstamped'];

describe('GET /workflows/runs — a user\'s list holds only what the gates call hers (M5)', () => {
  for (const [who, path] of [
    ['ayse', '/workflows/runs'],
    ['app', '/workflows/runs?resourceId=u-ayse'],
    ['ops', '/workflows/runs?resourceId=u-ayse'],
  ] as const) {
    it(`${who} ${path}`, async () => {
      const { call } = await seedWorkflows();
      const res = await call(who, path);
      expect(res.status).toBe(200);
      const ids = (JSON.parse(res.body) as { runId: string }[]).map((r) => r.runId);
      expect(ids).toContain('wf-ayse');
      for (const id of NOT_HERS) expect(ids, `${id} is not Ayşe's`).not.toContain(id);
    });
  }

  it('each row the list refuses is one the gates refuse her too', async () => {
    const { call } = await seedWorkflows();
    for (const id of NOT_HERS) {
      expect((await call('ayse', `/workflows/runs/${id}/cancel`, {})).status, id).toBe(404);
    }
  });

  it('staff with no filter still sees the whole organization', async () => {
    const { call } = await seedWorkflows();
    const ids = (JSON.parse((await call('ops', '/workflows/runs')).body) as { runId: string }[]).map((r) => r.runId);
    for (const id of ['wf-ayse', 'wf-staff', 'wf-unknown', 'wf-unstamped']) expect(ids).toContain(id);
  });
});

describe('sibling listings: the same rows stay out of a user\'s list', () => {
  async function seedAgentRuns() {
    const s = await setup();
    const { call, config } = s;
    expect((await call('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: 'hi', threadId: 't-ayse' })).status).toBe(200);
    expect((await call('ops', '/agents/a/run', { runId: 'r-staff', prompt: 'hi', threadId: 't-staff' })).status).toBe(200);
    await createGnl(config).run('a', { runId: 'r-unknown', prompt: 'hi' });
    return s;
  }

  for (const [who, path] of [
    ['ayse', '/runs'],
    ['ayse', '/runs?limit=50'],
    ['app', '/runs?resourceId=u-ayse'],
    ['ops', '/runs?resourceId=u-ayse'],
  ] as const) {
    it(`GET ${path} as ${who}: agent runs`, async () => {
      const { call } = await seedAgentRuns();
      const res = await call(who, path);
      expect(res.status).toBe(200);
      const parsed = JSON.parse(res.body) as { runId: string }[] | { items: { runId: string }[] };
      const ids = (Array.isArray(parsed) ? parsed : parsed.items).map((r) => r.runId);
      expect(ids).toEqual(['r-ayse']);
    });
  }

  for (const [who, path] of [
    ['ayse', '/threads'],
    ['app', '/threads?resourceId=u-ayse'],
    ['ops', '/threads?resourceId=u-ayse'],
  ] as const) {
    it(`GET ${path} as ${who}: threads`, async () => {
      const { call } = await seedAgentRuns();
      const res = await call(who, path);
      expect(res.status).toBe(200);
      const ids = (JSON.parse(res.body) as { id?: string; threadId?: string }[]).map((t) => t.id ?? t.threadId);
      expect(ids).toEqual(['t-ayse']);
    });
  }

  it('GET /runs/:id: an ownerless or unknown run reads as missing to her', async () => {
    const { call } = await seedAgentRuns();
    expect((await call('ayse', '/runs/r-ayse')).status).toBe(200);
    expect((await call('ayse', '/runs/r-staff')).status).toBe(404);
    expect((await call('ayse', '/runs/r-unknown')).status).toBe(404);
    expect((await call('app', '/runs/r-staff?resourceId=u-ayse')).status).toBe(404);
  });
});
