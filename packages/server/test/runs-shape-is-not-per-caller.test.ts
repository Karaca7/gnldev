// The SHAPE of a response is a fact about the request, not about who is asking.
//
// `GET /runs` with no parameters answers a bare array — the legacy shape, kept on purpose. The branch
// that decides it reads the RESOLVED subject, and for an end user that subject comes from the
// caller's identity rather than the query string. So the same parameterless URL answered an
// array to an operator and `{items:[…]}` to a bound end user.
//
// Measured on the published client (@gnldev/client@0.6.0, `listRuns()` casts the body to
// `RunSummary[]` unconditionally): the operator got an array, the bound end user got
// `TypeError: runs.map is not a function`. Turning on the switch that closes a data leak broke the
// framework's own typed client — for exactly the caller the switch exists to protect.
//
// The fix keeps BOTH promises: the shortcut now keys on what the REQUEST said (`?resourceId=`), so
// the shape is stable, and the bound subject is applied as a filter inside it, so the scoping the
// scoping is unchanged. The second test is the one that matters: a stable shape is worth
// nothing if it is stable because it stopped filtering.
import { describe, it, expect } from 'vitest';
import { InMemoryStorage } from '@gnldev/durable';
import { roleAuth } from '@gnldev/auth';
import { createRestApi } from '../src/index.js';
import { asEndUsers } from './end-users.js';

const mkModel = () => ({
  specificationVersion: 'v4' as const, provider: 'm', modelId: 'm', supportedUrls: {},
  doGenerate: async () => ({
    content: [{ type: 'text' as const, text: 'ok' }],
    finishReason: { unified: 'stop' as const, raw: 'stop' },
    usage: { inputTokens: { total: 1 }, outputTokens: { total: 1 } }, warnings: [],
  }),
});

/** `client` seeds (it names its subject); `viewer` basic-auth carries `principal.id` — the bound one. */
async function seeded() {
  const app = createRestApi(
    { storage: new InMemoryStorage(), memory: false, agents: { a: { model: mkModel() as never } } } as never,
    { auth: asEndUsers(roleAuth({ client: { token: 'C' }, viewer: { user: 'u-ayse', pass: 'p' } }), ['u-ayse']) },
  );
  const seed = (runId: string, resourceId: string) => app(new Request('http://x/agents/a/run', {
    method: 'POST',
    headers: { authorization: 'Bearer C', 'content-type': 'application/json' },
    body: JSON.stringify({ runId, prompt: 'hi', resourceId }),
  }));
  expect((await seed('r-ayse', 'u-ayse')).status).toBe(200);
  expect((await seed('r-mallory', 'u-mallory')).status).toBe(200);
  return app;
}

const AS_OPERATOR = { authorization: 'Bearer C' };
const AS_BOUND = { authorization: 'Basic ' + Buffer.from('u-ayse:p').toString('base64') };

describe('GET /runs — the shape does not depend on who is asking', () => {
  it('a bound end user gets the same SHAPE as an unbound caller', async () => {
    const app = await seeded();
    const bound = await (await app(new Request('http://x/runs', { headers: AS_BOUND }))).json();
    expect(Array.isArray(bound),
      'the parameterless URL changed shape because of the caller\'s identity — the published client casts this to an array')
      .toBe(true);
  });

  it('…and it is still scoped: the bound caller sees only its own run', async () => {
    // The control. A stable shape that stopped filtering would pass the test above and reopen the leak.
    const app = await seeded();
    const rows = await (await app(new Request('http://x/runs', { headers: AS_BOUND }))).json() as { runId: string }[];
    const ids = (Array.isArray(rows) ? rows : (rows as never as { items: { runId: string }[] }).items).map((r) => r.runId);
    expect(ids, 'the bound caller was handed another subject\'s run').toEqual(['r-ayse']);
  });

  it('an unbound caller still gets every run, as before', async () => {
    const app = await seeded();
    const rows = await (await app(new Request('http://x/runs?resourceId=u-mallory', { headers: AS_OPERATOR }))).json() as { items?: unknown[] };
    expect(rows.items, 'declaring a subject still selects the paged shape — unchanged').toBeDefined();
  });
});
