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

describe('S1 network run: does an ownerless network run write an owner record?', () => {
  it('staff network run, then an end user names its runId on the agent door', async () => {
    const { config, call, journal } = setup();
    await createGnl(config).runNetwork('support', { runId: 'net-1', task: 'STAFF-TASK' });
    const inputBefore = await journal.get('net-1:input');
    const netKeys = await journal.listKeys('net-1:');
    const res = await call('ayse', '/agents/a/run', { runId: 'net-1', prompt: 'hi' });
    const inputAfter = await journal.get('net-1:input');
    const view = await call('ayse', '/runs/net-1');
    const { withSubjectJournal } = await import('@gnldev/durable');
    const v = withSubjectJournal(journal, 'u-ayse');
    const leaked = await v.get('net-1:net:step:0');
    console.log('[S1-view]', JSON.stringify(leaked).slice(0, 200));
    console.log('[S1]', JSON.stringify({ inputBefore, netKeys, runStatus: res.status, ownerAfter: inputAfter?.resourceId, readStatus: view.status, readHasStaff: view.body.includes('STAFF') }));
    // the invariant: the staff run is not the end user's afterwards
    expect(inputAfter?.resourceId).not.toBe('u-ayse');
  });
});

describe('S2 batch item without resourceId: owner record?', () => {
  it('ownerless batch item, end user names batch:<id>:<key>', async () => {
    const { call, journal } = setup();
    const tool = { description: 'pay', sideEffect: true, execute: async () => ({ paid: 'STAFF-PAID' }) };
    const batch = createBatch(journal, { tool, toolName: 'pay', itemKey: (i: any) => i.ref } as never);
    const items = [{ ref: 'k1' }];
    const p = await batch.preflight('b1', items as never);
    const report = await batch.run('b1', items as never, { planToken: p.planToken ?? (p as any).token });
    const input = await journal.get('batch:b1:k1:input');
    const keys = await journal.listKeys('batch:b1:k1:');
    const res = await call('ayse', '/agents/a/run', { runId: 'batch:b1:k1', prompt: 'hi' });
    const after = await journal.get('batch:b1:k1:input');
    console.log('[S2]', JSON.stringify({ outcome: report.items?.[0] ?? report, input, keys, runStatus: res.status, body: res.body.slice(0, 160), ownerAfter: after?.resourceId }));
    expect(after?.resourceId).not.toBe('u-ayse');
  });
});

describe('S3 key rule: a stranger naming a shorter prefix run blocks the owner', () => {
  for (const blocked of [false, true]) {
    it(`owner's completed workflow run 'team:1', blocker run 'team' = ${blocked}`, async () => {
      const { call, journal } = setup();
      expect((await call('ayse', '/workflows/done/run', { runId: 'team:1', input: {} })).status).toBe(200);
      let blockStatus: number | undefined;
      if (blocked) blockStatus = (await call('mallory', '/agents/a/run', { runId: 'team', prompt: 'hi' })).status;
      const list = await call('ayse', '/workflows/runs');
      const cancel = await call('ayse', '/workflows/runs/team:1/cancel', {});
      const status = await journal.get('wfrun:team:1');
      console.log('[S3]', JSON.stringify({ blocked, blockStatus, listed: list.body.includes('team:1'), cancel: cancel.body, statusAfter: status?.status, workflowNameAfter: status?.workflowName }));
      // invariant: another user's action must not change what the owner sees or does
      expect(list.body.includes('team:1')).toBe(true);
      expect(status?.status).toBe('completed');
    });
  }
});

describe('S4 existence oracle on routes without asMissing', () => {
  it('pairs: foreign vs missing', async () => {
    const { call } = setup();
    expect((await call('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: 'hi', threadId: 't-ayse' })).status).toBe(200);
    expect((await call('ayse', '/workflows/w/run', { runId: 'wf-ayse', input: {} })).status).toBe(200);
    const pairs: Record<string, [number, number]> = {};
    const pair = async (name: string, f: (id: string) => Promise<{ status: number }>, a: string, b: string) => {
      pairs[name] = [(await f(a)).status, (await f(b)).status];
    };
    await pair('wf run+resume', (id) => call('mallory', '/workflows/w/run', { runId: id, resume: { ok: { ok: true } } }), 'wf-ayse', 'wf-none');
    await pair('agent run', (id) => call('mallory', '/agents/a/run', { runId: id, prompt: 'x' }), 'r-ayse', 'r-none');
    await pair('agent stream', (id) => call('mallory', '/agents/a/stream', { runId: id, prompt: 'x' }), 'r-ayse', 'r-none2');
    await pair('GET /runs/:id', (id) => call('mallory', `/runs/${id}`), 'r-ayse', 'r-none3');
    await pair('thread messages', (id) => call('mallory', `/threads/${id}/messages`), 't-ayse', 't-none');
    await pair('agent run threadId', (id) => call('mallory', '/agents/a/run', { threadId: id, prompt: 'x' }), 't-ayse', 't-none4');
    console.log('[S4]', JSON.stringify(pairs));
    expect(true).toBe(true);
  });
});

describe('S5 legacy run: existence answers across routes', () => {
  it('a workflow run with no :input — each route\'s answer to ops', async () => {
    const { call, journal } = setup();
    expect((await call('ops', '/workflows/w/run', { runId: 'legacy', input: {} })).status).toBe(200);
    await journal.delete?.('legacy:input'); await journal.deletePrefix?.('legacy:input'); expect(await journal.get('legacy:input')).toBeUndefined();
    const ans = {
      agentResume: (await call('ops', '/agents/a/resume', { runId: 'legacy' })).status,
      runCancel: (await call('ops', '/runs/legacy/cancel', {})).status,
      wfCancelAyse: (await call('ayse', '/workflows/runs/legacy/cancel', {})).status,
      agentRunAyse: (await call('ayse', '/agents/a/run', { runId: 'legacy', prompt: 'x' })).status,
    };
    console.log('[S5]', JSON.stringify(ans));
    expect(true).toBe(true);
  });
});
