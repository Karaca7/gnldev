// 0.7.0 release panel D-9: the object-form `rateLimit` bucket was keyed by the caller's id without its
// organization, so globex's `u1` exhausted acme's `u1` — two different people, one window. A bucket is
// now (organization, caller). Siblings: two organizations' staff with the same id, and an application of each naming the same user id.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createMcpServer } from '../src/server.js';

type P = { kind: string; id?: string; orgId?: string; roles: string[] };
function server() {
  let current: P | undefined;
  const s = createMcpServer({
    journal: new InMemoryJournal() as never,
    identify: () => current as never,
    allowTool: () => true,
    rateLimit: { maxCalls: 2, windowMs: 60_000 },
    tools: { t: { description: 't', inputSchema: { type: 'object' }, execute: async () => ({ ok: true }) } } as never,
  } as never) as any;
  let n = 0;
  const call = async (who: P) => {
    current = who;
    // A user's call carries a work key; staff's carries none (staff work has no user address); an
    // application names the user it acts for.
    const r = await s.callTool({
      name: 't', arguments: {}, caller: {},
      ...(who.kind === 'subject' ? { idempotencyKey: `k${++n}` } : {}),
      ...(who.kind === 'application' ? { resourceId: 'u-x' } : {}),
    });
    return JSON.stringify(r).includes('Rate limit exceeded') ? 'LIMITED' : r?.isError ? `ERR ${JSON.stringify(r)}` : 'OK';
  };
  return { call };
}

describe('D-9: one rate-limit bucket per organization and caller', () => {
  const cases: Array<[string, P, P]> = [
    ['a user', { kind: 'subject', id: 'u1', orgId: 'acme', roles: [] }, { kind: 'subject', id: 'u1', orgId: 'globex', roles: [] }],
    ['staff', { kind: 'operator', id: 'ops', orgId: 'acme', roles: ['admin'] }, { kind: 'operator', id: 'ops', orgId: 'globex', roles: ['admin'] }],
    ['an application', { kind: 'application', id: 'app', orgId: 'acme', roles: [] }, { kind: 'application', id: 'app', orgId: 'globex', roles: [] }],
  ];
  for (const [label, acme, globex] of cases) {
    it(`${label}: globex exhausting its window leaves acme's namesake untouched`, async () => {
      const { call } = server();
      expect(await call(globex)).toBe('OK');
      expect(await call(globex)).toBe('OK');
      expect(await call(globex)).toBe('LIMITED');
      expect(await call(acme)).toBe('OK');
      expect(await call(acme)).toBe('OK');
      expect(await call(acme)).toBe('LIMITED');
    });
  }

  it('control: the same caller in the same organization still shares one window', async () => {
    const { call } = server();
    const u = { kind: 'subject', id: 'u1', orgId: 'acme', roles: [] };
    expect([await call(u), await call(u), await call(u)]).toEqual(['OK', 'OK', 'LIMITED']);
  });
});
