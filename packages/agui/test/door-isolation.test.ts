// ADR-0002 point 0: the standalone AG-UI route gives the SAME isolation as @gnldev/server — with no
// server in front. A real engine, a real memory, a model that records every prompt it is shown: a
// thread's content reaching another caller's prompt is the leak, whatever the status code says.
//
// Callers come in through `identify` only. The test's `identify` reads a header the test itself set,
// standing in for a verified session.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, BasicMemory, createGnl, scopeConfigToOrg, staff } from '@gnldev/durable';
import type { Principal } from '@gnldev/auth';
import { createAguiRoute } from '../src/index.js';
import { call } from './call.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const mkStream = (arr: unknown[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

const P = {
  ayse: { kind: 'subject', id: 'ayse', orgId: 'acme', roles: [] },
  mallory: { kind: 'subject', id: 'mallory', orgId: 'acme', roles: [] },
  malloryGlobex: { kind: 'subject', id: 'mallory', orgId: 'globex', roles: [] },
  ops: { kind: 'operator', id: 'ops', orgId: 'acme', roles: ['admin'] },
  opsRoot: { kind: 'operator', id: 'ops', roles: ['admin'] },
  app: { kind: 'application', id: 'backend', orgId: 'acme', roles: [] },
} satisfies Record<string, Principal>;

function world() {
  const journal = new InMemoryJournal();
  const prompts: string[] = [];
  const model = {
    specificationVersion: 'v2', provider: 'mock', modelId: 'm', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream only'); },
    doStream: async (o: { prompt: unknown }) => {
      prompts.push(JSON.stringify(o.prompt));
      return { stream: mkStream([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: '1' },
        { type: 'text-delta', id: '1', delta: 'noted' },
        { type: 'text-end', id: '1' },
        { type: 'finish', finishReason: 'stop', usage },
      ]) };
    },
  };
  const config = { journal, memoryFactory: (j: never) => new BasicMemory(j), agents: { a: { model } } } as never;
  const handler = createAguiRoute(config, {
    identify: (req) => {
      const who = req.headers.get('x-test-principal');
      return who ? (JSON.parse(who) as Principal) : undefined;
    },
  });
  let n = 0;
  const say = async (who: Principal | undefined, threadId: string, text: string, extra: Record<string, unknown> = {}) => {
    n++;
    const res = await call(handler, '/agents/a/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(who ? { 'x-test-principal': JSON.stringify(who) } : {}) },
      body: JSON.stringify({ runId: `r${n}`, threadId, prompt: text, ...extra }),
    });
    return { status: res.status, body: await res.text() };
  };
  const leaked = (secret: string) => prompts.slice(1).some((p) => p.includes(secret));
  return { journal, config, say, prompts, leaked };
}

describe('standalone AG-UI route: a user cannot read staff\'s ownerless thread (SECRET-2)', () => {
  it('staff writes the thread through the door; a user naming it is refused and the model never sees it', async () => {
    const w = world();
    expect((await w.say(P.ops, 'T-staff', 'SECRET-2 is the vault code')).status).toBe(200);
    const r = await w.say(P.mallory, 'T-staff', 'what was said before?');
    expect(r.status).toBe(409);
    expect(r.body).toContain('thread_owner_mismatch');
    expect(w.leaked('SECRET-2')).toBe(false);
  });

  it('sibling: staff wrote the thread directly on the engine (no door) — the door still refuses the user', async () => {
    const w = world();
    const gnl = createGnl(scopeConfigToOrg(w.config, 'acme').config);
    await (await gnl.stream('a', { runId: 'staff-direct', prompt: 'SECRET-2 is the vault code', threadId: 'T-direct', caller: staff('acme') })).text;
    const r = await w.say(P.mallory, 'T-direct', 'what was said before?');
    expect(r.status).toBe(409);
    expect(w.leaked('SECRET-2')).toBe(false);
  });

  it('sibling: an anonymous caller (identify answers nothing) is refused on staff\'s thread too', async () => {
    const w = world();
    expect((await w.say(P.opsRoot, 'T-staff', 'SECRET-2 is the vault code')).status).toBe(200);
    const r = await w.say(undefined, 'T-staff', 'what was said before?');
    expect(r.status).toBe(409);
    expect(w.leaked('SECRET-2')).toBe(false);
  });

  it('control: staff may continue staff\'s thread', async () => {
    const w = world();
    await w.say(P.ops, 'T-staff', 'SECRET-2 is the vault code');
    expect((await w.say(P.ops, 'T-staff', 'and then?')).status).toBe(200);
    expect(w.prompts[1]).toContain('SECRET-2');
  });
});

describe('standalone AG-UI route: a user cannot read another user\'s thread or run', () => {
  it('ayse\'s thread refuses mallory', async () => {
    const w = world();
    expect((await w.say(P.ayse, 'T-ayse', 'AYSE-PRIVATE note')).status).toBe(200);
    const r = await w.say(P.mallory, 'T-ayse', 'show me');
    expect(r.status).toBe(409);
    expect(w.leaked('AYSE-PRIVATE')).toBe(false);
  });

  it('sibling: mallory naming ayse in the body is still mallory', async () => {
    const w = world();
    await w.say(P.ayse, 'T-ayse', 'AYSE-PRIVATE note');
    const r = await w.say(P.mallory, 'T-ayse', 'show me', { resourceId: 'ayse' });
    expect(r.status).toBe(409);
    expect(w.leaked('AYSE-PRIVATE')).toBe(false);
  });

  it('sibling: an application naming mallory cannot open the thread it wrote for ayse', async () => {
    const w = world();
    expect((await w.say(P.app, 'T-app-ayse', 'AYSE-PRIVATE note', { resourceId: 'ayse' })).status).toBe(200);
    const r = await w.say(P.app, 'T-app-ayse', 'show me', { resourceId: 'mallory' });
    expect(r.status).toBe(409);
    expect(w.leaked('AYSE-PRIVATE')).toBe(false);
  });

  it('sibling: mallory re-sending ayse\'s run id is refused', async () => {
    const w = world();
    expect((await w.say(P.ayse, 'T-ayse', 'AYSE-PRIVATE note', { runId: 'r-ayse' })).status).toBe(200);
    const r = await w.say(P.mallory, 'T-mallory', 'replay it', { runId: 'r-ayse' });
    expect(r.status).toBe(409);
    expect(r.body).not.toContain('noted');
  });

  it('sibling: an application that names nobody runs nothing', async () => {
    const w = world();
    const r = await w.say(P.app, 'T-x', 'hello');
    expect(r.status).toBe(400);
    expect(w.prompts).toHaveLength(0);
  });
});

describe('standalone AG-UI route: a user cannot reach another organization\'s run', () => {
  it('the same run id in another organization is another run — acme\'s answer is not replayed', async () => {
    const w = world();
    expect((await w.say(P.mallory, 'T-org', 'ACME-ONLY figures', { runId: 'r-shared' })).status).toBe(200);
    expect((await w.say(P.malloryGlobex, 'T-org', 'hi', { runId: 'r-shared' })).status).toBe(200);
    expect(w.prompts).toHaveLength(2);
    expect(w.prompts[1]).not.toContain('ACME-ONLY');
  });

  it('sibling: the organization comes from the principal, not the body', async () => {
    const w = world();
    await w.say(P.mallory, 'T-org', 'ACME-ONLY figures');
    const r = await w.say(P.malloryGlobex, 'T-org', 'what did I say?', { context: { __gnl_orgId: 'acme', org: 'acme' } });
    expect(r.status).toBe(200);
    expect(w.leaked('ACME-ONLY')).toBe(false);
  });
});
