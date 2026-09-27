// `chatSurface()` on the REST API: the useChat wire format with the REST door's identity decision.
// Before, the standalone route answered 200 to a request with no credential, ran the model, and filed
// an ownerless run where neither the user's REST history nor their organization's staff could see it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { chatSurface } from '../../chat-adapter/src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let modelCalls = 0;
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('no gen'); },
  doStream: async () => {
    modelCalls++;
    return { stream: new ReadableStream({ start(c) {
      for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hello' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p);
      c.close();
    } }) };
  },
};
const SECRET = 'app-signing-secret-at-least-32-bytes!!';
const tok = (sub: string) => `Bearer ${signSubjectToken({ sub }, SECRET)}`;

function mk() {
  const api = createRestApi({ storage: new InMemoryStorage(), memory: false, agents: { a: { model } } } as never, {
    auth: roleAuth({ admin: { token: 'STAFF', orgId: 'acme' }, endUsers: { secret: SECRET, orgId: 'acme' } }),
    org: {}, protectionsBanner: false, surfaces: [chatSurface()],
  } as never);
  const call = async (auth: string | undefined, path: string, body?: unknown) => {
    const res = await api(new Request(`http://x${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: res.status, runId: res.headers.get('x-gnl-run-id'), text: await res.text() };
  };
  return { call };
}
const turn = (conv: string, msg: string) => ({ id: conv, messages: [{ id: msg, role: 'user', parts: [{ type: 'text', text: 'hi' }] }] });

describe('chatSurface on createRestApi', () => {
  it('speaks the useChat stream format', async () => {
    const r = await mk().call(tok('u-ayse'), '/agents/a/chat', turn('c1', 'm1'));
    expect(r.status).toBe(200);
    expect(r.text).toContain('hello');
    expect(r.text).toContain('"type":"text-delta"');
  });

  it('a request with no credential never reaches the model', async () => {
    const before = modelCalls;
    expect((await mk().call(undefined, '/agents/a/chat', turn('c1', 'm1'))).status).toBe(401);
    expect(modelCalls).toBe(before);
  });

  it('the turn is the user\'s: in their history, in their organization, and nobody else\'s', async () => {
    const { call } = mk();
    const r = await call(tok('u-ayse'), '/agents/a/chat', turn('c1', 'm1'));
    const mine = JSON.parse((await call(tok('u-ayse'), '/runs')).text) as { runId: string; resourceId: string }[];
    expect(mine.map((x) => [x.runId, x.resourceId])).toEqual([[r.runId, 'u-ayse']]);
    expect((await call(tok('u-mallory'), `/runs/${encodeURIComponent(r.runId!)}`)).status).toBe(404);
    expect(JSON.parse((await call('Bearer STAFF', '/runs')).text).map((x: { runId: string }) => x.runId)).toContain(r.runId);
  });

  it('two users whose clients number turns the same way get two runs', async () => {
    // useChat ids are the client's own; `c1:m1` is an ordinary pair. The turn key is a NAME under the
    // subject, so the same pair from two users is two pieces of work, not one run and a refusal.
    // Each on their own conversation — the turn ids collide, the threads do not.
    const { call } = mk();
    const a = await call(tok('u-ayse'), '/agents/a/chat', { ...turn('c1', 'm1'), threadId: 't-ayse' });
    const m = await call(tok('u-mallory'), '/agents/a/chat', { ...turn('c1', 'm1'), threadId: 't-mallory' });
    expect(a.status).toBe(200);
    expect(m.status).toBe(200);
    expect(m.runId).not.toBe(a.runId);
  });

  it('a conversation id is not shared: the second user to name it is refused, not joined', async () => {
    // The thread comes from the client's conversation id. Two users naming the same one used to share
    // one thread — its history and its thread-scoped dedup window — whenever no memory store could
    // name an owner.
    const { call } = mk();
    expect((await call(tok('u-ayse'), '/agents/a/chat', turn('c7', 'm1'))).status).toBe(200);
    const m = await call(tok('u-mallory'), '/agents/a/chat', turn('c7', 'm1'));
    expect([403, 404]).toContain(m.status);
  });

  it('a retried turn is the same run; a body cannot rename the owner', async () => {
    const { call } = mk();
    const a = await call(tok('u-ayse'), '/agents/a/chat', { ...turn('c2', 'm1'), resourceId: 'u-mallory' });
    const b = await call(tok('u-ayse'), '/agents/a/chat', turn('c2', 'm1'));
    expect(b.runId).toBe(a.runId);
    expect(JSON.parse((await call(tok('u-mallory'), '/runs')).text)).toEqual([]);
  });
});
