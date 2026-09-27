// `gnl dev` serves the formats the project declares — the chat surface above all — and lets the app's
// browser origin call it. The docs said `gnl dev` "serves everything while you build", and the scaffold
// wrote a chat surface, but `gnl dev` mounted the REST API without it: POST /agents/:name/chat was a
// 404 on the one command a new project starts with. And src/identity.ts pointed at APP_ORIGIN, which
// `gnl dev` never read.
import { describe, it, expect, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import * as Durable from '@gnldev/durable';
import * as Hono from 'hono';
import * as Server from '@gnldev/server';
import * as Studio from '@gnldev/studio';
import * as StudioAi from '@gnldev/studio/ai';
import * as Auth from '@gnldev/auth';
import { buildDevApp, type DevRuntimeModules } from '../src/dev-server.js';

const rt: DevRuntimeModules = { hono: Hono, durable: Durable, server: Server, studio: Studio, studioAi: StudioAi, auth: Auth };
const model: any = {
  specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({ content: [{ type: 'text', text: 'ok' }], finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 }, warnings: [] }),
  doStream: async () => ({
    stream: new ReadableStream({ start(c) {
      c.enqueue({ type: 'text-start', id: 't' }); c.enqueue({ type: 'text-delta', id: 't', delta: 'hello' }); c.enqueue({ type: 'text-end', id: 't' });
      c.enqueue({ type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } }); c.close();
    } }),
  }),
};
const echo = {
  path: '/agents/:name/echo',
  decode: (b: any) => ({ prompt: b.text ?? 'hi', turnKey: `${b.conv}:${b.msg}` }),
  encode: (result: any) => new Response(result.textStream.pipeThrough(new TextEncoderStream())),
};
const saved = process.env.APP_ORIGIN;
afterEach(() => { if (saved === undefined) delete process.env.APP_ORIGIN; else process.env.APP_ORIGIN = saved; });

describe('gnl dev', () => {
  it('serves the surfaces the config declares', async () => {
    const app = buildDevApp({ journal: new InMemoryJournal(), agents: { a: { model } }, studio: false, surfaces: [echo] } as never, rt);
    const res = await app.request('/agents/a/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'hi', conv: 'c1', msg: 'm1' }) });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('hello');
  });

  it('answers the app\'s origin when APP_ORIGIN is set, and no other', async () => {
    process.env.APP_ORIGIN = 'https://app.example';
    const app = buildDevApp({ journal: new InMemoryJournal(), agents: { a: { model } }, studio: false } as never, rt);
    const pre = (origin: string) => app.request('/agents', { method: 'OPTIONS', headers: { origin, 'access-control-request-method': 'GET' } });
    expect((await pre('https://app.example')).headers.get('access-control-allow-origin')).toBe('https://app.example');
    expect((await pre('https://evil.example')).headers.get('access-control-allow-origin')).toBeNull();
  });
});
