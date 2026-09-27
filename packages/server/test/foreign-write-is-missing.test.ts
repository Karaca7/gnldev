// A write to a run the caller may not see answers exactly as a write to a run that does not exist —
// same status, same body. A 403 for "someone else's" next to a 404 for "nobody's" told a user guessing
// ids which ones exist. Staff keep the 403: they see everything in their scope, so there is nothing to
// hide from them, and a clear refusal is worth more.
//
// Not covered, by nature: a write that STARTS something under a name (a run id, a thread id) cannot
// hide that the name is taken — a free one starts, a taken one is refused.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory } from '@gnldev/durable';
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
  mallory: { kind: 'subject', id: 'u-mallory', roles: ['admin'] },
  app: { kind: 'application', roles: ['admin'] },
  ops: { kind: 'operator', id: 'ops', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
};
async function setup() {
  const storage = new InMemoryStorage();
  const api = createRestApi(
    { storage, memory: new BasicMemory(storage.runs), agents: { a: { model } },
      workflows: { w: workflow<unknown>().then(step('s', async () => 'x')).then(waitForResume<{ ok: boolean }>('ok')) } } as never,
    { auth: auth as never, protectionsBanner: false },
  );
  const call = async (who: string, path: string, body: unknown = {}) => {
    const r = await api(new Request(`http://x${path}`, { method: 'POST', headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }));
    return { status: r.status, body: await r.text() };
  };
  expect((await call('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: 'hi' })).status).toBe(200);
  expect((await call('ayse', '/workflows/w/run', { runId: 'wf-ayse', input: {} })).status).toBe(200);
  return call;
}
const ghost = (s: string) => s.replace(/r-ayse|r-none|wf-ayse|wf-none/g, '<id>');

describe('someone else\'s run is, to an end user, a run that does not exist', () => {
  it('cancel', async () => {
    const call = await setup();
    const foreign = await call('mallory', '/runs/r-ayse/cancel');
    const missing = await call('mallory', '/runs/r-none/cancel');
    expect(foreign.status).toBe(404);
    expect(ghost(foreign.body)).toBe(ghost(missing.body));
  });

  it('workflow cancel', async () => {
    const call = await setup();
    const foreign = await call('mallory', '/workflows/runs/wf-ayse/cancel');
    const missing = await call('mallory', '/workflows/runs/wf-none/cancel');
    expect(foreign.status).toBe(404);
    expect(ghost(foreign.body)).toBe(ghost(missing.body));
  });

  it('resume', async () => {
    const call = await setup();
    const foreign = await call('mallory', '/agents/a/resume', { runId: 'r-ayse' });
    const missing = await call('mallory', '/agents/a/resume', { runId: 'r-none' });
    expect(foreign.status).toBe(404);
    expect(ghost(foreign.body)).toBe(ghost(missing.body));
  });

  it('an application naming the wrong user gets the same', async () => {
    const call = await setup();
    const foreign = await call('app', '/runs/r-ayse/cancel?resourceId=u-mallory');
    const missing = await call('app', '/runs/r-none/cancel?resourceId=u-mallory');
    expect(foreign.status).toBe(404);
    expect(ghost(foreign.body)).toBe(ghost(missing.body));
  });

  it('staff still get the plain refusal when they state the wrong owner, and act on the right one', async () => {
    const call = await setup();
    expect((await call('ops', '/runs/r-ayse/cancel?resourceId=u-mallory')).status).toBe(403);
    expect((await call('ops', '/runs/r-ayse/cancel')).status).toBe(200);
  });

  it('the owner acts on her own', async () => {
    const call = await setup();
    expect((await call('ayse', '/runs/r-ayse/cancel')).status).toBe(200);
  });
});
