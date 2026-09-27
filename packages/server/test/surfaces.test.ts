// A surface is a wire format on the REST stream door, and nothing else. Every identity decision —
// gate, organization, subject — is the door's, so a surface cannot be mounted without them. Before
// this, @gnldev/chat-adapter and @gnldev/agui were standalone routes: with roleAuth configured, a
// request with no token got 200, ran the model, and wrote an ownerless run into the ROOT scope where
// neither REST history nor the organization's staff could see it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth, signSubjectToken } from '@gnldev/auth';
import { createRestApi, type StreamSurface } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
let modelCalls = 0;
const model: any = {
  specificationVersion: 'v2', provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => { throw new Error('no gen'); },
  doStream: async () => {
    modelCalls++;
    return { stream: new ReadableStream({ start(c) {
      for (const p of [{ type: 'stream-start', warnings: [] }, { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'hi' }, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'stop', usage }]) c.enqueue(p);
      c.close();
    } }) };
  },
};
const SECRET = 'app-signing-secret-at-least-32-bytes!!';

/** A minimal wire format: `{ conv, msg, text }` in, plain text out. */
const echo: StreamSurface = {
  path: '/agents/:name/echo',
  decode: (b) => ({ prompt: b.text ?? 'hi', turnKey: `${b.conv}:${b.msg}`, threadId: b.conv, ...(b.resourceId !== undefined ? { resourceId: b.resourceId } : {}) }),
  encode: (result) => new Response(result.textStream.pipeThrough(new TextEncoderStream())),
};

function mk(extra: Record<string, unknown> = {}) {
  const api = createRestApi({ storage: new InMemoryStorage(), memory: false, agents: { a: { model } } } as never, {
    auth: roleAuth({ admin: { token: 'STAFF', orgId: 'acme' }, client: { token: 'CLIENT', orgId: 'acme' }, endUsers: { secret: SECRET, orgId: 'acme' } }),
    org: {}, protectionsBanner: false, surfaces: [echo], ...extra,
  } as never);
  const call = async (auth: string | undefined, path: string, body?: unknown) => {
    const res = await api(new Request(`http://x${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: res.status, runId: res.headers.get('x-gnl-run-id'), text: await res.text() };
  };
  return { api, call };
}
const tok = (sub: string) => `Bearer ${signSubjectToken({ sub }, SECRET, { ttlSec: 300 })}`;

describe('surfaces: one identity decision for every wire format', () => {
  it('no credential, or a forged one, never reaches the model', async () => {
    const { call } = mk();
    const m0 = modelCalls;
    expect((await call(undefined, '/agents/a/echo', { conv: 'c', msg: '1' })).status).toBe(401);
    expect((await call('Bearer not.a.jwt', '/agents/a/echo', { conv: 'c', msg: '1' })).status).toBe(401);
    expect(modelCalls).toBe(m0);
  });

  it('a subject token owns its run, in its organization, and a body cannot rename it', async () => {
    const { call } = mk();
    const r = await call(tok('u-ayse'), '/agents/a/echo', { conv: 'c', msg: '1', resourceId: 'u-mallory' });
    expect(r.status).toBe(200);
    const mine = JSON.parse((await call(tok('u-ayse'), '/runs')).text);
    expect(mine.map((x: any) => [x.runId, x.resourceId])).toEqual([[r.runId, 'u-ayse']]);
    expect((await call(tok('u-mallory'), `/runs/${encodeURIComponent(r.runId!)}`)).status).toBe(404);
    // Staff of the same organization sees it — the run lives in acme's scope, not the root.
    expect(JSON.parse((await call('Bearer STAFF', '/runs')).text).map((x: any) => x.runId)).toContain(r.runId);
  });

  it('an application credential must name the subject, exactly as on REST', async () => {
    const { call } = mk();
    const bare = await call('Bearer CLIENT', '/agents/a/echo', { conv: 'c', msg: '1' });
    expect(bare.status).toBe(400);
    const rest = await call('Bearer CLIENT', '/agents/a/stream', { runId: 'r1', prompt: 'hi' });
    expect(bare.text).toBe(rest.text);
    expect((await call('Bearer CLIENT', '/agents/a/echo', { conv: 'c', msg: '2', resourceId: 'u-ayse' })).status).toBe(200);
  });

  it('the same turn twice is the same run', async () => {
    const { call } = mk();
    const a = await call(tok('u-ayse'), '/agents/a/echo', { conv: 'c', msg: '9' });
    const b = await call(tok('u-ayse'), '/agents/a/echo', { conv: 'c', msg: '9' });
    expect(b.runId).toBe(a.runId);
  });

  it('a surface cannot take a REST path', () => {
    expect(() => mk({ surfaces: [{ ...echo, path: '/agents/:name/stream' }] })).toThrow(/REST route/);
  });
});

describe('cors', () => {
  const pre = (api: any, origin: string) => api(new Request('http://x/agents/a/echo', {
    method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'authorization,content-type' },
  }));
  it('off by default: no CORS headers at all', async () => {
    const { api } = mk();
    expect((await pre(api, 'https://app.example')).headers.get('access-control-allow-origin')).toBeNull();
  });
  it('answers a named origin before any gate, and only that origin', async () => {
    const { api } = mk({ cors: { origins: ['https://app.example'] } });
    const ok = await pre(api, 'https://app.example');
    expect(ok.status).toBe(204);
    expect(ok.headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect(ok.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(ok.headers.get('access-control-allow-credentials')).toBeNull();
    expect((await pre(api, 'https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
    const res = await api(new Request('http://x/runs', { headers: { origin: 'https://app.example', authorization: tok('u-ayse') } }));
    expect(res.headers.get('access-control-expose-headers')).toContain('X-Gnl-Run-Id');
  });
});
