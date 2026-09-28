// The server maps a request to the engine's caller ONE way: @gnldev/auth `engineCallerOf(principal,
// named)` (ADR-0002). These cases are where a hand-built mapping and the one mapping disagreed.
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
  ops: { kind: 'operator', id: 'ops', roles: ['admin'] },
  app: { kind: 'application', id: 'app', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: () => ({ allow: true }),
};

function setup() {
  const storage = new InMemoryStorage();
  const api = createRestApi({ storage, agents: { a: { model } } } as never, { auth: auth as never, protectionsBanner: false });
  const call = async (who: string, path: string, body?: unknown) => {
    const r = await api(new Request(`http://x${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: r.status, body: await r.text() };
  };
  return { call, journal: storage.runs as any };
}

describe('a name no user can have is refused, not filed under nobody', () => {
  // `engineCallerOf` reads these ids as nobody (`unknown`) — the same rule `callerKind` applies to a
  // subject principal carrying them. The route's own validation let C1 controls and U+2028 through,
  // so a run was filed under a name the one mapping calls nobody's.
  for (const bad of ['u\u0085x', 'u x', 'u\u009fx']) {
    for (const who of ['app', 'ops'] as const) {
      it(`${who} naming ${JSON.stringify(bad)}: 400 on /run and /stream, nothing written`, async () => {
        const { call, journal } = setup();
        const run = await call(who, '/agents/a/run', { runId: 'r1', prompt: 'hi', resourceId: bad });
        expect(run.status).toBe(400);
        expect(run.body).toContain('control characters');
        expect((await call(who, '/agents/a/stream', { runId: 'r2', prompt: 'hi', resourceId: bad })).status).toBe(400);
        expect(await journal.get('r1:input')).toBeUndefined();
      });
    }
  }

  it('a printable id is still the user it names (sibling)', async () => {
    const { call, journal } = setup();
    expect((await call('app', '/agents/a/run', { runId: 'r1', prompt: 'hi', resourceId: 'Ayşe Öztürk #7' })).status).toBe(200);
    expect((await journal.get('r1:input'))?.resourceId).toBe('Ayşe Öztürk #7');
  });
});

describe('who a run is filed under, per kind', () => {
  it('subject: itself, whatever the body names', async () => {
    const { call, journal } = setup();
    expect((await call('ayse', '/agents/a/run', { runId: 'r1', prompt: 'hi', resourceId: 'u-mallory' })).status).toBe(200);
    expect((await journal.get('r1:input'))?.resourceId).toBe('u-ayse');
  });

  it('application: the user it names', async () => {
    const { call, journal } = setup();
    expect((await call('app', '/agents/a/run', { runId: 'r1', prompt: 'hi', resourceId: 'u-ayse' })).status).toBe(200);
    expect((await journal.get('r1:input'))?.resourceId).toBe('u-ayse');
  });

  it('operator naming a user: that user (it speaks for her on this request)', async () => {
    const { call, journal } = setup();
    expect((await call('ops', '/agents/a/run', { runId: 'r1', prompt: 'hi', resourceId: 'u-ayse' })).status).toBe(200);
    expect((await journal.get('r1:input'))?.resourceId).toBe('u-ayse');
  });

  it('operator naming nobody: staff', async () => {
    const { call, journal } = setup();
    expect((await call('ops', '/agents/a/run', { runId: 'r1', prompt: 'hi' })).status).toBe(200);
    const rec = await journal.get('r1:input');
    expect(rec?.resourceId).toBeUndefined();
    expect(rec?.ownerKind).toBe('staff');
  });
});

describe('staff naming a user is held to that user, and keeps its own work', () => {
  it('cancel: Ayşe\'s run with ?resourceId=u-mallory is refused; with her name or none, allowed', async () => {
    const { call } = setup();
    expect((await call('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: 'hi' })).status).toBe(200);
    expect((await call('ops', '/runs/r-ayse/cancel?resourceId=u-mallory', {})).status).toBe(403);
    expect((await call('ops', '/runs/r-ayse/cancel?resourceId=u-ayse', {})).status).toBe(200);
    expect((await call('ops', '/runs/r-ayse/cancel', {})).status).toBe(200);
  });

  it('a staff run is still staff\'s when staff names a user', async () => {
    const { call } = setup();
    expect((await call('ops', '/agents/a/run', { runId: 'r-staff', prompt: 'hi' })).status).toBe(200);
    expect((await call('ops', '/runs/r-staff/cancel?resourceId=u-ayse', {})).status).toBe(200);
    expect((await call('ops', '/runs/r-staff?resourceId=u-ayse')).status).toBe(200);
  });
});

describe('resume acts for the recorded owner, read the one way', () => {
  it('an unstamped record naming a user is staff\'s: staff resumes it as staff, and it does not become hers', async () => {
    const { call, journal } = setup();
    expect((await call('ops', '/agents/a/run', { runId: 'r-x', prompt: 'hi' })).status).toBe(200);
    // Rewritten without the journal's stamp: a caller's bytes, which `runOwnerOf` reads as staff's.
    const { _v: _drop, ownerKind: _k, ...rest } = (await journal.get('r-x:input')) as Record<string, unknown>;
    await journal.put('r-x:input', { ...rest, resourceId: 'u-ayse' });
    const res = await call('ops', '/agents/a/resume', { runId: 'r-x' });
    expect(res.status, res.body).toBe(200);
    // and Ayşe, whom the bytes name, cannot reach it
    expect((await call('ayse', '/agents/a/resume', { runId: 'r-x' })).status).toBe(404);
  });

  it('staff resuming Ayşe\'s run runs it as Ayşe (sibling)', async () => {
    const { call, journal } = setup();
    expect((await call('ayse', '/agents/a/run', { runId: 'r-ayse', prompt: 'hi' })).status).toBe(200);
    expect((await call('ops', '/agents/a/resume', { runId: 'r-ayse' })).status).toBe(200);
    expect((await journal.get('r-ayse:input'))?.resourceId).toBe('u-ayse');
  });
});
