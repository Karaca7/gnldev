// Architecture audit probes (sibling scenarios). Each test LOGS what happened and asserts the
// invariant the fix claims: "an end user cannot act on a run that exists and is not theirs".
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, createGnl, createBatch } from '@gnldev/durable';
import { workflow, step, waitForResume } from '@gnldev/workflow';
import { createRestApi } from '../src/index.js';

const route = (agent: string, task: string) => JSON.stringify({ action: 'route', agent, task });
const final = (answer: string) => JSON.stringify({ action: 'final', answer });
const textModel = (fn: () => string) => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: fn() }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } },
    warnings: [],
  }),
});
const PRINCIPALS: Record<string, unknown> = {
  ayse: { kind: 'subject', id: 'u-ayse', roles: ['admin'] },
  mallory: { kind: 'subject', id: 'u-mallory', roles: ['admin'] },
  ops: { kind: 'operator', id: 'ops', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
};

function setup() {
  const storage = new InMemoryStorage();
  let i = 0;
  const router = textModel(() => [route('expert', 'STAFF-TASK'), final('STAFF-ANSWER')][Math.min(i++, 1)]!);
  const config = {
    storage, memory: new BasicMemory(storage.runs),
    agents: { a: { model: textModel(() => 'ok') }, expert: { description: 'x', model: textModel(() => 'STAFF-SECRET') } },
    networks: { support: { router, agents: ['expert'] } },
    workflows: {
      w: workflow<unknown>().then(step('s', async () => 'x')).then(waitForResume<{ ok: boolean }>('ok')),
      done: workflow<unknown>().then(step('s', async () => 'finished')),
    },
  } as any;
  const api = createRestApi(config, { auth: auth as never, protectionsBanner: false });
  const call = async (who: string, path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') => {
    const r = await api(new Request(`http://x${path}`, { method, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(body ?? {}) } : {}) }));
    return { status: r.status, body: await r.text() };
  };
  const journal = storage.runs as any;
  return { config, call, journal };
}

// Candidate B: the kit's S1–S3 as assertions.
describe('R7/R8/R9 (candidate B)', () => {
  it('R7 a staff network run is not adopted by an end user through the agent door', async () => {
    const { config, call, journal } = setup();
    await createGnl(config).runNetwork('support', { runId: 'net-1', task: 'STAFF-TASK', principal: { kind: 'staff' } } as never);
    const res = await call('ayse', '/agents/a/run', { runId: 'net-1', prompt: 'hi' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await journal.get('net-1:input'))?.resourceId).toBeUndefined();
    expect((await call('ayse', '/runs/net-1')).status).toBe(404);
  });

  it('R7 an ownerless batch item is not adopted by an end user', async () => {
    const { call, journal } = setup();
    const tool = { description: 'pay', sideEffect: true, execute: async () => ({ paid: 'STAFF-PAID' }) };
    const batch = createBatch(journal, { tool, toolName: 'pay', itemKey: (i: any) => i.ref, principal: { kind: 'staff' } } as never);
    const items = [{ ref: 'k1' }];
    const p = await batch.preflight('b1', items as never);
    await batch.run('b1', items as never, { planToken: (p as any).token });
    const res = await call('ayse', '/agents/a/run', { runId: 'batch:b1:k1', prompt: 'hi' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect((await journal.get('batch:b1:k1:input'))?.resourceId).toBeUndefined();
  });

  it('R9 a stranger naming a shorter-prefix run cannot hide or cancel the owner\'s completed run', async () => {
    const { call, journal } = setup();
    expect((await call('ayse', '/workflows/done/run', { runId: 'team:1', input: {} })).status).toBe(200);
    const block = await call('mallory', '/agents/a/run', { runId: 'team', prompt: 'hi' });
    expect(block.status).toBe(403);
    expect((await call('ayse', '/workflows/runs')).body).toContain('team:1');
    await call('ayse', '/workflows/runs/team:1/cancel', {});
    expect((await journal.get('wfrun:team:1'))?.status).toBe('completed');
  });
});
