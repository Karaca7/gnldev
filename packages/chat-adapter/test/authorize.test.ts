// `identify` says who is calling; `authorize` says what they may do. Per ADR-0003, the
// standalone route asks the provider's `authorize` for `agents:run` before a run, as @gnldev/server
// does, and asks nothing when it was not handed one.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createChatRoute } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let modelCalls = 0;
const model = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('stream only'); },
  doStream: async () => {
    modelCalls++;
    return { stream: new ReadableStream({ start(c) {
      for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'ok' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p);
      c.close();
    } }) };
  },
};
const SECRET = 'app-signing-secret-at-least-32-bytes!!';
const auth = roleAuth({ viewer: { token: 'VIEW' }, admin: { token: 'ADMIN' }, endUsers: { secret: SECRET } })!;
const user = signSubjectToken({ sub: 'ayse' }, SECRET);

let n = 0;
async function send(withAuthorize: boolean, token?: string) {
  n++;
  const app = createChatRoute({ journal: new InMemoryJournal(), agents: { a: { model } } } as never, {
    identify: (req) => auth.authenticate(req) ?? undefined,
    ...(withAuthorize ? { authorize: (p, req, ctx) => auth.authorize(p, req, ctx) } : {}),
  });
  const before = modelCalls;
  const res = await app.request('/agents/a/chat', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ id: `c${n}`, messages: [{ id: `m${n}`, role: 'user', parts: [{ type: 'text', text: 'hi' }] }] }),
  });
  await res.text();
  return { status: res.status, ran: modelCalls > before };
}

describe('standalone chat route: `authorize`', () => {
  it('refuses a read-only operator the run, and the model never runs', async () => {
    expect(await send(true, 'VIEW')).toEqual({ status: 403, ran: false });
  });
  it('lets an admin and an end user run', async () => {
    expect(await send(true, 'ADMIN')).toEqual({ status: 200, ran: true });
    expect(await send(true, user)).toEqual({ status: 200, ran: true });
  });
  it('answers 401 to a request with no caller', async () => {
    expect(await send(true)).toEqual({ status: 401, ran: false });
  });
  it('without `authorize`, asks nothing: the viewer runs, as before', async () => {
    expect(await send(false, 'VIEW')).toEqual({ status: 200, ran: true });
  });
});
