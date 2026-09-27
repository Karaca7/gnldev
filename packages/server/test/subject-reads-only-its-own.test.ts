// An end user reads its own data, by DEFAULT, and a named member of staff reads everyone's.
//
// Before `Principal.kind`, the server decided "is this an operator?" from whether the principal had
// a name: `!p?.id || isClient || isPlatformAdmin`. Both answers were wrong. An end user with a name
// was an operator on every read path unless the deployment found `subjectBinding: 'strict'` (named
// in zero .md files), so Mallory read Ayşe's runs and messages with a 200. And a member of staff with
// a name was bound to that name on the write path: `POST /run { resourceId: 'u-ayse' }` from the
// `ops` login filed the run under `ops`. The kind is now stamped where the principal is minted and
// read here through `callerKind`, with no flag in front of it.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
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
  app: { kind: 'application', roles: ['client'] },
  // An end user someone handed the platform-admin ROLE. A role is not the kind.
  crowned: { kind: 'subject', id: 'u-crowned', roles: ['admin', 'platform-admin'] },
  root: { kind: 'operator', roles: ['admin', 'platform-admin'] },
  // A subject whose provider gave it no name: it can be held to nothing, so it reaches nothing.
  nameless: { kind: 'subject', roles: ['admin'] },
};
// Every role is `admin` and `authorize` allows all, so ONLY the kind can explain a difference.
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
};

function makeApi() {
  const threads = new Map<string, string>();
  const memory = {
    loadContext: async (t: string, o?: { resourceId?: string }) => { if (o?.resourceId) threads.set(t, o.resourceId); return { messages: [] as unknown[] }; },
    append: async () => {},
    getMessages: async (t: string) => [{ role: 'user', content: `SECRET-${t}` }],
    getThreadResource: async (t: string) => threads.get(t),
    listThreads: async (o: { resourceId: string }) => [...threads].filter(([, r]) => r === o.resourceId).map(([id, r]) => ({ id, resourceId: r })),
    listAllThreads: async () => [...threads].map(([id, r]) => ({ id, resourceId: r })),
  };
  const api = createRestApi(
    { storage: new InMemoryStorage(), memoryFactory: () => memory, agents: { a: { model } } } as never,
    { auth: auth as never, protectionsBanner: false },
  );
  const call = (who: string, path: string, body?: unknown) => api(new Request(`http://x${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { call };
}

async function withAyseRun() {
  const t = makeApi();
  const r = await t.call('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: 'hi', threadId: 't-ayse' });
  expect(r.status).toBe(200);
  return t;
}
const runIds = async (res: Response) => {
  const body = await res.json() as { runId: string }[] | { items: { runId: string }[] };
  return (Array.isArray(body) ? body : body.items).map((r) => r.runId);
};

describe('an end user, with no option set', () => {
  it('cannot read another end user\'s run', async () => {
    const { call } = await withAyseRun();
    expect((await call('mallory', '/runs/r-ayse')).status).toBe(403);
  });

  it('cannot read it by NAMING the owner either', async () => {
    const { call } = await withAyseRun();
    expect((await call('mallory', '/runs/r-ayse?resourceId=u-ayse')).status).toBe(403);
    expect(await runIds(await call('mallory', '/runs?resourceId=u-ayse'))).toEqual([]);
  });

  it('does not see it in a listing', async () => {
    const { call } = await withAyseRun();
    expect(await runIds(await call('mallory', '/runs'))).toEqual([]);
    expect(await runIds(await call('ayse', '/runs'))).toEqual(['r-ayse']);
  });

  it('cannot read another end user\'s conversation', async () => {
    const { call } = await withAyseRun();
    const r = await call('mallory', '/threads/t-ayse/messages');
    expect(r.status).toBe(403);
    expect(await r.text()).not.toContain('SECRET');
    const listed = await (await call('mallory', '/threads')).json() as { threads?: { id: string }[] } | { id: string }[];
    expect(JSON.stringify(listed)).not.toContain('t-ayse');
  });

  it('cannot file work under someone else\'s name — its run is its own', async () => {
    const { call } = makeApi();
    expect((await call('mallory', '/agents/a/run', { runId: 'r-m', prompt: 'hi', resourceId: 'u-ayse' })).status).toBe(200);
    expect(await runIds(await call('ayse', '/runs'))).toEqual([]);
    expect(await runIds(await call('mallory', '/runs'))).toEqual(['r-m']);
  });

  it('cannot read organization-wide usage', async () => {
    const { call } = makeApi();
    expect((await call('mallory', '/usage')).status).toBe(403);
  });
});

describe('staff surfaces', () => {
  it('the agent registry refuses an end user even with the platform-admin role', async () => {
    const { call } = makeApi();
    expect((await call('crowned', '/agents/registry')).status).toBe(403);
    expect((await call('crowned', '/agents/registry/a/approve', {})).status).toBe(403);
    expect((await call('root', '/agents/registry')).status).not.toBe(403);
  });
});

describe('a member of staff with a name', () => {
  it('reads any end user\'s run and conversation', async () => {
    const { call } = await withAyseRun();
    expect((await call('ops', '/runs/r-ayse')).status).toBe(200);
    expect((await call('ops', '/threads/t-ayse/messages')).status).toBe(200);
    expect(await runIds(await call('ops', '/runs'))).toEqual(['r-ayse']);
  });

  it('files work under the user it names, not under its own name', async () => {
    const { call } = makeApi();
    expect((await call('ops', '/agents/a/run', { runId: 'r-o', prompt: 'hi', resourceId: 'u-ayse' })).status).toBe(200);
    // Asked of the RECORD, through a filter staff can use: whose run is it?
    expect(await runIds(await call('ops', '/runs?resourceId=u-ayse'))).toEqual(['r-o']);
    expect(await runIds(await call('ops', '/runs?resourceId=ops')), 'the run was filed under the staff member').toEqual([]);
  });
});

describe('a caller that cannot be held to anything', () => {
  it('a nameless subject is refused, not treated as staff', async () => {
    const { call } = await withAyseRun();
    expect((await call('nameless', '/runs')).status).toBe(403);
    expect((await call('nameless', '/runs/r-ayse')).status).toBe(403);
  });
});

describe('the application credential is unchanged', () => {
  it('must name the user it acts for, and then reaches that user', async () => {
    const { call } = await withAyseRun();
    expect((await call('app', '/runs')).status).toBe(400);
    expect(await runIds(await call('app', '/runs?resourceId=u-ayse'))).toEqual(['r-ayse']);
  });
});
