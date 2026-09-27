// Studio is a staff console: ONE assertion over the whole route table — every route that is not
// self-describing refuses every non-operator kind. Today that rule lives in one middleware
// (server.ts, `callerKind(principal) !== 'operator'`); this walk makes a route mounted before it, on a
// sub-app, or behind a future exemption fail in CI instead of shipping.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createStudioApi } from '../src/server.js';

/** Routes allowed to answer a non-operator. Everything else must 403. Keep this list SHORT. */
const SELF_DESCRIBING: Record<string, string> = {
  'GET /capabilities': 'what this caller may use; public, pre-login',
  'GET /me': "the caller's own identity",
};

const PRINCIPALS: Record<string, unknown> = {
  ops: { kind: 'operator', roles: ['admin', 'platform-admin'] },
  ayse: { kind: 'subject', id: 'u-ayse', roles: ['admin', 'platform-admin'] },
  nameless: { kind: 'subject', roles: ['admin'] },
  app: { kind: 'application', roles: ['admin'] },
};
const auth = {
  authenticate: (req: Request) => PRINCIPALS[req.headers.get('authorization')?.replace('Bearer ', '') ?? ''] ?? null,
  authorize: (p: unknown) => (p ? { allow: true } : { allow: false, status: 401 }),
};

describe('Studio refuses every non-operator on every non-self-describing route', () => {
  const api = createStudioApi({ reader: new InMemoryJournal(), auth: auth as never }) as unknown as
    ((r: Request) => Promise<Response>) & { routeTable: readonly { method: string; path: string }[] };
  const routes = api.routeTable.filter((r) => r.method !== 'ALL'); // app.use() entries

  it('the inventory is real, and the exemptions name existing routes', () => {
    expect(routes.length).toBeGreaterThan(50);
    const keys = new Set(routes.map((r) => `${r.method} ${r.path}`));
    expect(Object.keys(SELF_DESCRIBING).filter((k) => !keys.has(k))).toEqual([]);
  });

  it.each(['ayse', 'nameless', 'app'])('%s gets 403 everywhere', async (who) => {
    const served: string[] = [];
    for (const r of routes) {
      const key = `${r.method} ${r.path}`;
      if (key in SELF_DESCRIBING) continue;
      const path = r.path.replace(/:([A-Za-z_]\w*)/g, 'x').replace(/\*/g, 'x');
      const init: RequestInit = { method: r.method, headers: { authorization: `Bearer ${who}`, 'content-type': 'application/json' } };
      if (!['GET', 'HEAD'].includes(r.method)) init.body = '{}';
      const res = await api(new Request(`http://x${path}`, init));
      if (res.status !== 403) served.push(`${key} -> ${res.status}`);
    }
    expect(served, 'a Studio route answered a non-operator').toEqual([]);
  }, 60_000);
});
