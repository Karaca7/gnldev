// A thread belongs to whoever opened it, and stays theirs: not re-derived from whichever runs happen
// to be left, so neither a second user's run on it, nor a retention sweep of the owner's runs, nor the
// second user's account deletion can move it. Every door asks the same record.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage, BasicMemory, purgeResource, sweepRuns, toJournal } from '@gnldev/durable';
import { workflow, step } from '@gnldev/workflow';
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
  ops: { kind: 'operator', id: 'ops', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
};
function makeApi() {
  const storage = new InMemoryStorage();
  const memory = new BasicMemory(storage.runs);
  const api = createRestApi(
    { storage, memory, agents: { a: { model } }, workflows: { w: workflow<string>().then(step('s', async () => 'x')) } } as never,
    { auth: auth as never, protectionsBanner: false },
  );
  const call = (who: string, path: string, body?: unknown) => api(new Request(`http://x${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { call, storage };
}
const refused = (s: number) => s === 403 || s === 404;
const PIN = 'my PIN is 4417';

async function ayseOpens() {
  const t = makeApi();
  expect((await t.call('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: PIN, threadId: 't-ayse' })).status).toBe(200);
  return t;
}

describe('a thread\'s owner is recorded, not re-derived', () => {
  it('the workflow door refuses another user\'s thread, like the agent door', async () => {
    const { call } = await ayseOpens();
    const wf = await call('mallory', '/workflows/w/run', { runId: 'wf-m', threadId: 't-ayse', input: 'x' });
    expect(refused(wf.status), `workflow door ${wf.status}`).toBe(true);
    const mine = await call('ayse', '/threads/t-ayse/messages');
    expect(mine.status).toBe(200);
    expect(JSON.stringify(await mine.json())).toContain('4417');
    expect((await call('ayse', '/agents/a/run', { runId: 'r-ayse-2', prompt: 'again', threadId: 't-ayse' })).status).toBe(200);
  });

  it('after the owner\'s runs are swept, the thread is still hers — nobody else claims it', async () => {
    const { call, storage } = await ayseOpens();
    await sweepRuns(toJournal(storage.runs) as never, { olderThanMs: -1, now: Date.now() + 10_000 } as never);
    expect(await storage.runs.get('r-ayse:input')).toBeUndefined();
    const m = await call('mallory', '/agents/a/run', { runId: 'r-m', prompt: 'what did I say?', threadId: 't-ayse' });
    expect(refused(m.status), `mallory run ${m.status}`).toBe(true);
    const read = await call('mallory', '/threads/t-ayse/messages');
    expect(read.status).toBe(404);
    expect(await read.text()).not.toContain('4417');
    // And it is still HERS, not merely nobody's: she reads it and carries on.
    const mine = await call('ayse', '/threads/t-ayse/messages');
    expect(mine.status).toBe(200);
    expect(JSON.stringify(await mine.json())).toContain('4417');
    expect((await call('ayse', '/agents/a/run', { runId: 'r-ayse-3', prompt: 'still me', threadId: 't-ayse' })).status).toBe(200);
  });

  it('deleting another user\'s account deletes none of her messages', async () => {
    const { storage } = await ayseOpens();
    // A stray run of mallory's on her thread — the shape an older release let through.
    await storage.runs.put('r-stray:input', { at: 1, resourceId: 'u-mallory', threadId: 't-ayse', _v: 2 });
    await storage.runs.put('r-stray:model:0', { text: 'x' });
    const removed = await purgeResource(toJournal(storage.runs) as never, 'u-mallory');
    expect(removed, 'the stray run itself is erased').toBeGreaterThan(0);
    expect(await storage.runs.get('r-stray:input')).toBeUndefined();
    const left = await storage.runs.get('mem:t-ayse:messages');
    expect(left, 'her messages are still there').toBeDefined();
    expect(JSON.stringify(left)).toContain('4417');
  });

  it('a thread that exists with no owner is staff\'s: an end user neither writes to it nor reads it', async () => {
    const { call } = makeApi();
    expect((await call('ops', '/agents/a/run', { runId: 'r-ops', prompt: 'OPS-NOTE', threadId: 't-ops' })).status).toBe(200);
    expect(refused((await call('ayse', '/agents/a/run', { runId: 'r-a', prompt: 'hi', threadId: 't-ops' })).status)).toBe(true);
    expect((await call('ayse', '/threads/t-ops/messages')).status).toBe(404);
    expect((await call('ops', '/agents/a/run', { runId: 'r-ops-2', prompt: 'more', threadId: 't-ops' })).status).toBe(200);
  });

  it('an old thread with messages and no owner anywhere is staff\'s, not the next caller\'s', async () => {
    // What a thread opened before owner records looks like once retention took its runs.
    const { call, storage } = makeApi();
    await storage.runs.put('mem:t-old:messages', [{ role: 'user', content: 'OLD-SECRET' }]);
    expect(refused((await call('ayse', '/agents/a/run', { runId: 'r-a', prompt: 'hi', threadId: 't-old' })).status)).toBe(true);
    const read = await call('ayse', '/threads/t-old/messages');
    expect(read.status).toBe(404);
    expect(await read.text()).not.toContain('OLD-SECRET');
  });

  it('a brand-new thread is the first caller\'s', async () => {
    const { call } = makeApi();
    expect((await call('mallory', '/agents/a/run', { runId: 'r-m', prompt: 'hi', threadId: 't-new' })).status).toBe(200);
    expect((await call('mallory', '/threads/t-new/messages')).status).toBe(200);
    expect((await call('ayse', '/threads/t-new/messages')).status).toBe(404);
  });
});
