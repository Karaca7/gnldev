// The server's run gates read the engine's ONE answer (`runOwnerOf` + `decideRunAccess`) for every
// run kind (ADR-0002 point 3, R7/R8/R9). Each case below was a way to act on a run that exists and is
// not the caller's: an ownerless network or batch run adopted through the agent door, a shorter-prefix
// run hiding the owner's workflow, a fork that crashed before its owner record, a legacy run with rows
// but no record.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, createGnl, createBatch, forkRun, toJournal, STAFF } from '@gnldev/durable';
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

function setup(agentText = 'ok') {
  const storage = new InMemoryStorage();
  let i = 0;
  const router = textModel(() => [route('expert', 'STAFF-TASK'), final('STAFF-ANSWER')][Math.min(i++, 1)]!);
  const config = {
    storage, memory: new BasicMemory(storage.runs),
    agents: { a: { model: textModel(() => agentText) }, expert: { description: 'x', model: textModel(() => 'STAFF-SECRET') } },
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
  return { config, call, journal: storage.runs as any, storage };
}

describe('R7: an ownerless run of any kind is not adopted by an end user', () => {
  it('network run (staff): the agent door refuses, the owner record stays ownerless, the run reads as missing', async () => {
    const { config, call, journal } = setup();
    await createGnl(config).runNetwork('support', { runId: 'net-1', task: 'STAFF-TASK', caller: STAFF } as never);
    const res = await call('ayse', '/agents/a/run', { runId: 'net-1', prompt: 'hi' });
    expect(res.status).toBe(403);
    expect((await journal.get('net-1:input'))?.resourceId).toBeUndefined();
    expect((await call('ayse', '/runs/net-1')).status).toBe(404);
  });

  it('network run started with no caller (unknown): the same', async () => {
    const { config, call, journal } = setup();
    await createGnl(config).runNetwork('support', { runId: 'net-2', task: 'STAFF-TASK' } as never);
    expect((await call('ayse', '/agents/a/run', { runId: 'net-2', prompt: 'hi' })).status).toBe(403);
    expect((await journal.get('net-2:input'))?.ownerKind).toBe('unknown');
  });

  it('batch item (no owner given): the agent door refuses it', async () => {
    const { call, journal } = setup();
    const tool = { description: 'pay', sideEffect: true, execute: async () => ({ paid: 'STAFF-PAID' }) };
    const batch = createBatch(journal, { tool, toolName: 'pay', itemKey: (i: any) => i.ref } as never);
    const items = [{ ref: 'k1' }];
    const p = await batch.preflight('b1', items as never);
    await batch.run('b1', items as never, { planToken: (p as any).token });
    expect((await call('ayse', '/agents/a/run', { runId: 'batch:b1:k1', prompt: 'hi' })).status).toBe(403);
    expect((await journal.get('batch:b1:k1:input'))?.resourceId).toBeUndefined();
  });
});

describe('R9: a stranger naming a shorter-prefix run cannot hide or change the owner\'s run', () => {
  for (const door of ['/agents/a/run', '/workflows/done/run'] as const) {
    it(`blocker through ${door}`, async () => {
      const { call, journal } = setup();
      expect((await call('ayse', '/workflows/done/run', { runId: 'team:1', input: {} })).status).toBe(200);
      const block = await call('mallory', door, door.startsWith('/agents') ? { runId: 'team', prompt: 'hi' } : { runId: 'team', input: {} });
      expect(block.status).toBe(403);
      expect((await call('ayse', '/workflows/runs')).body).toContain('team:1');
      await call('ayse', '/workflows/runs/team:1/cancel', {});
      expect((await journal.get('wfrun:team:1'))?.status).toBe('completed');
    });
  }
});

describe('forkRun interrupted before its last write (the fork crash takeover)', () => {
  for (const starter of ['ayse', 'ops'] as const) {
    it(`source started by ${starter}: another user cannot take the half-written fork, nor read it`, async () => {
      const { call, storage } = setup('SECRET-OF-AYSE');
      expect((await call(starter, '/agents/a/run', { runId: 'src', prompt: 'hi' })).status).toBe(200);
      const j = toJournal(storage.runs) as any;
      const crashing = new Proxy(j, { get(t, k) {
        if (k === 'put') return async (key: string, v: unknown) => { if (key.endsWith(':input')) throw new Error('crash (injected)'); return t.put(key, v); };
        const v = Reflect.get(t, k, t); return typeof v === 'function' ? v.bind(t) : v;
      } });
      await expect(forkRun(crashing, 'src', 1, 'fk')).rejects.toThrow(/crash/);
      expect(await j.get('fk:model:0')).toBeDefined();
      const takeover = await call('mallory', '/agents/a/run', { runId: 'fk', prompt: 'mine now' });
      expect(takeover.status).toBe(403);
      expect((await j.get('fk:input'))?.resourceId).toBe(starter === 'ayse' ? 'u-ayse' : undefined);
      const read = await call('mallory', '/runs/fk');
      expect(read.status).toBe(404);
      expect(read.body).not.toContain('SECRET');
    });
  }
});

describe('D2: a legacy run (record missing, rows present) through REST', () => {
  it('an end user cannot start it, resume it, cancel it or read it; staff still can', async () => {
    const { call, journal } = setup('STAFF-SECRET');
    expect((await call('ops', '/agents/a/run', { runId: 'legacy', prompt: 'x' })).status).toBe(200);
    await journal.deletePrefix('legacy:input');
    const start = await call('mallory', '/agents/a/run', { runId: 'legacy', prompt: 'x' });
    expect(start.status).toBe(403);
    expect(start.body).not.toContain('STAFF-SECRET');
    expect((await call('mallory', '/agents/a/resume', { runId: 'legacy' })).status).toBe(404);
    expect((await call('mallory', '/runs/legacy/cancel', {})).status).toBe(404);
    expect((await call('mallory', '/runs/legacy')).status).toBe(404);
    expect(await journal.get('legacy:input')).toBeUndefined();
    expect((await call('ops', '/runs/legacy')).status).toBe(200);
  });
});
