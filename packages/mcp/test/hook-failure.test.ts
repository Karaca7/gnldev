// A configured hook throws, and what the caller is told about it.
//
// `identity`, `allowTool`, `workKey` and `rateLimit` are the deployment's own functions, and the useful
// ones reach a store. Measured before this file existed, over a real SDK Client:
//
//   MCP error -32603: pg: connection to 10.0.3.14:5432 refused (user=svc_gnl)
//
// An internal address, a port and a service account name, verbatim to whoever called. All four already
// failed CLOSED — the tool ran zero times in every case — so the defect was disclosure, not a bypass,
// and this file pins both halves: the tool still must not run, and the caller still must not be told
// why in the deployment's words.
//
// The same rule was already applied twice on this door this round (a blocked run is translated; a
// forbidden tool is made indistinguishable from a missing one) and not to this path. Third instance of
// one rule reaching two of three places.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { InMemoryJournal } from '@gnldev/durable';
import { createMcpServer, serveMcp, type McpServerOptions } from '../src/server.js';

const SECRET = 'pg: connection to 10.0.3.14:5432 refused (user=svc_gnl)';
const boom = () => { throw new Error(SECRET); };
const ok: McpServerOptions['identity'] = () => ({ resourceId: 'acme-ltd' });

let err: ReturnType<typeof vi.spyOn>;
afterEach(() => { err?.mockRestore(); });
const quiet = () => { err = vi.spyOn(console, 'error').mockImplementation(() => {}); return err; };

function serverWith(extra: Partial<McpServerOptions>, ran: string[]) {
  return createMcpServer({
    journal: new InMemoryJournal(),
    identity: ok,
    allowTool: () => true,
    tools: { t: { description: 'c', execute: async () => { ran.push('ran'); return { ok: 1 }; } } },
    ...extra,
  } as McpServerOptions);
}

/** Every hook, the door it can fail on, and whether the list door reaches it at all. */
const CASES: { hook: string; extra: Partial<McpServerOptions>; breaksList: boolean }[] = [
  { hook: 'identity', extra: { identity: boom as McpServerOptions['identity'] }, breaksList: true },
  { hook: 'allowTool', extra: { allowTool: boom as McpServerOptions['allowTool'] }, breaksList: true },
  { hook: 'tools', extra: { tools: boom as unknown as McpServerOptions['tools'] }, breaksList: true },
  { hook: 'workKey', extra: { workKey: boom as McpServerOptions['workKey'] }, breaksList: false },
  { hook: 'rateLimit', extra: { rateLimit: boom as McpServerOptions['rateLimit'] }, breaksList: false },
];

describe('a hook that throws', () => {
  for (const { hook, extra, breaksList } of CASES) {
    it(`${hook}: the tool does not run, and the caller is not told why`, async () => {
      const spy = quiet();
      const ran: string[] = [];
      const s = serverWith(extra, ran);
      const msg = await s
        .callTool({ name: 't', arguments: {}, idempotencyKey: 'k', caller: {} })
        .then(() => 'resolved', (e: Error) => e.message);

      expect(ran, 'a failed hook must never let the tool run').toEqual([]);
      expect(msg, "the deployment's own error text must not reach the caller").not.toContain(SECRET);
      expect(msg, 'and the caller must learn WHICH hook, which is not a secret').toContain(`'${hook}' hook failed`);
      // The operator still gets the real thing, where the operator is.
      expect(spy.mock.calls.flat().some((a) => String((a as Error)?.message ?? a).includes(SECRET)),
        'the real error must be logged server-side').toBe(true);
    }, 60_000);
  }

  it('the list door is covered too, for the hooks it reaches', async () => {
    // `workKey` and `rateLimit` are call-only; the other three run on `tools/list` as well, and that
    // door threw the same raw message.
    for (const { hook, extra, breaksList } of CASES) {
      if (!breaksList) continue;
      quiet();
      const s = serverWith(extra, []);
      const msg = await s.listTools({ caller: {} }).then(() => 'resolved', (e: Error) => e.message);
      expect(msg, `${hook} on tools/list`).not.toContain(SECRET);
      expect(msg).toContain(`'${hook}' hook failed`);
      err?.mockRestore();
    }
  }, 60_000);

  it('and nothing leaks over the real SDK wire either', async () => {
    // The measurement that produced this file, re-run as the assertion.
    quiet();
    const { InMemoryTransport } = (await import('@modelcontextprotocol/sdk/inMemory.js')) as any;
    const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as any;
    const s = serverWith({ identity: boom as McpServerOptions['identity'] }, []);
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await serveMcp(s, st, { name: 't', version: '0' });
    const c = new Client({ name: 'c', version: '0' }, { capabilities: {} });
    await c.connect(ct);
    const called = await c.callTool({ name: 't', arguments: {}, _meta: { idempotencyKey: 'k' } })
      .then(() => 'resolved', (e: Error) => e.message);
    await c.close();
    expect(String(called), 'the wire is where it was measured leaking').not.toContain('10.0.3.14');
    expect(String(called)).toContain("'identity' hook failed");
  }, 60_000);

  it('a hook that RETURNS badly still fails closed — undefined is not consent', async () => {
    // The other half of a misbehaving hook: no throw, just a useless answer.
    const ran: string[] = [];
    const s = serverWith({ allowTool: (() => undefined) as unknown as McpServerOptions['allowTool'] }, ran);
    const msg = await s.callTool({ name: 't', arguments: {}, idempotencyKey: 'k', caller: {} })
      .then(() => 'resolved', (e: Error) => e.message);
    expect(ran).toEqual([]);
    expect(msg, 'an unpermitted tool is indistinguishable from a missing one').toContain('no such tool');
    expect((await s.listTools({ caller: {} })).tools, 'and it is not listed').toEqual([]);
  }, 60_000);
});
