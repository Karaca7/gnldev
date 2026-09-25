// The whole threat model over a REAL HTTP transport, with a real Bearer token.
//
// Every other test in this package uses InMemoryTransport, which authenticates nobody: `extra.authInfo`
// arrives as an empty object there, so those tests prove the plumbing is wired and nothing about the
// deployment that actually matters. A server exposed to more than one caller is exposed over HTTP.
//
// HYPOTHESIS, written before the first run: over a real streamable-HTTP transport, `identity` receives
// the clientId the HTTP middleware validated, `tools/list` is filtered per caller, and a second caller
// cannot reach the first caller's record.
//
// FALSIFICATION: if `extra.authInfo` arrives empty or undefined here, then `identity`, `allowTool` and
// the per-caller list are all inert in the only deployment where a second caller exists, and the design
// is wrong rather than merely unproven.
//
// LAYER ① IS NOT GNL'S. The middleware below validates the token and sets `req.auth`; that is the
// company's code, exactly as the MCP spec places it (authorization is OPTIONAL, and a server must
// validate that a token was issued for it as the audience). `serveMcp` never opens this socket.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server as HttpServer, type IncomingMessage } from 'node:http';
import { randomUUID } from 'node:crypto';
import { InMemoryJournal, purgeResource } from '@gnldev/durable';
import { createMcpServer, serveMcp, type McpServer } from '../src/server.js';

/** ① The company's own token table. GNL never sees this. */
const TOKENS: Record<string, { clientId: string; scopes: string[] }> = {
  'acme-token': { clientId: 'acme-key', scopes: ['tool:read_invoice'] },
  'other-token': { clientId: 'other-key', scopes: ['tool:read_invoice', 'tool:charge'] },
};
/** ② The mapping GNL is given — token already validated by the time this runs. */
const TENANT: Record<string, string> = { 'acme-key': 'acme-ltd', 'other-key': 'other-co' };

let httpServer: HttpServer;
let url: string;
let journal: InMemoryJournal;
let gnl: McpServer;
const seenCallers: unknown[] = [];
const invoices: string[] = [];
const charges: number[] = [];

beforeAll(async () => {
  const { StreamableHTTPServerTransport } = (await import('@modelcontextprotocol/sdk/server/streamableHttp.js')) as any;
  journal = new InMemoryJournal();
  gnl = createMcpServer({
    journal,
    identity: (caller) => {
      seenCallers.push(caller);
      const t = TENANT[caller.authInfo?.clientId ?? ''];
      return t ? { resourceId: t, actor: caller.authInfo?.clientId } : {};
    },
    allowTool: ({ name, caller }) => (caller.authInfo?.scopes ?? []).includes(`tool:${name}`),
    rateLimit: { maxCalls: 10, windowMs: 60_000 },
    tools: (ctx) => {
      // ④ the tool closes over WHOSE call this is — over HTTP, from a real token.
      const me = (ctx as Record<string, unknown>)['__gnl_resourceId'] as string | undefined;
      return {
        read_invoice: {
          description: 'invoice',
          execute: async (a: any) => {
            invoices.push(`${me}:${a.customer}`);
            if (a.customer !== me) return { refused: true, reason: 'not your invoice' };
            return { customer: me, iban: 'TR44 **** 9021' };
          },
        },
        charge: { description: 'charge', execute: async (a: any) => { charges.push(a.amount); return { charged: a.amount }; } },
      };
    },
  });

  const transports = new Map<string, any>();
  httpServer = createServer(async (req, res) => {
    // ① validate, then publish the result on the request. Everything below this line is GNL's.
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const info = TOKENS[bearer];
    if (!info) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    (req as IncomingMessage & { auth?: unknown }).auth = { token: bearer, clientId: info.clientId, scopes: info.scopes };

    const sid = req.headers['mcp-session-id'] as string | undefined;
    let transport = sid ? transports.get(sid) : undefined;
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => transports.set(id, transport),
      });
      await serveMcp(gnl, transport, { name: 'gnl-http', version: '0.0.0' });
    }
    await transport.handleRequest(req, res);
  });
  await new Promise<void>((r) => httpServer.listen(0, '127.0.0.1', r));
  const addr = httpServer.address() as { port: number };
  url = `http://127.0.0.1:${addr.port}/mcp`;
}, 60_000);

afterAll(async () => {
  await new Promise<void>((r) => httpServer.close(() => r()));
});

/** A real SDK Client over a real HTTP socket, carrying a real Bearer token. */
async function connect(token: string) {
  const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as any;
  const { StreamableHTTPClientTransport } = (await import('@modelcontextprotocol/sdk/client/streamableHttp.js')) as any;
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'probe', version: '0.0.0' }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

describe('over a real HTTP transport', () => {
  it('THE DECISIVE ONE — the validated token reaches identity', async () => {
    // If this fails with an empty authInfo, everything built today is inert where it matters.
    const c = await connect('acme-token');
    await c.listTools();
    await c.close();
    const withId = seenCallers.filter((x: any) => x?.authInfo?.clientId);
    expect(withId.length, 'identity must receive the clientId the middleware validated').toBeGreaterThan(0);
    expect((withId[0] as any).authInfo.clientId).toBe('acme-key');
    expect((withId[0] as any).authInfo.scopes).toContain('tool:read_invoice');
  }, 60_000);

  it('an unauthenticated caller never reaches GNL at all', async () => {
    // Layer ① doing its job: 401 from the middleware, before any MCP handler runs.
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('Bearer');
  }, 30_000);

  it('tools/list is filtered by the real token’s scopes', async () => {
    const acme = await connect('acme-token');
    const other = await connect('other-token');
    const a = await acme.listTools();
    const o = await other.listTools();
    await acme.close();
    await other.close();
    expect(a.tools.map((t: any) => t.name), 'acme may only read').toEqual(['read_invoice']);
    expect(o.tools.map((t: any) => t.name).sort(), 'the other caller may also charge').toEqual(['charge', 'read_invoice']);
  }, 60_000);

  it('a tool the token does not name is refused on call too', async () => {
    const acme = await connect('acme-token');
    // Indistinguishable from an invented name, over real HTTP: the filtered list is not contradicted.
    const forbidden = await acme.callTool({ name: 'charge', arguments: { amount: 5 }, _meta: { idempotencyKey: 'h1' } })
      .then(() => 'resolved', (e: Error) => e.message);
    const invented = await acme.callTool({ name: 'not_a_tool', arguments: {}, _meta: { idempotencyKey: 'h1b' } })
      .then(() => 'resolved', (e: Error) => e.message);
    await acme.close();
    expect(String(forbidden)).toContain('no such tool: charge');
    expect(String(invented)).toContain('no such tool: not_a_tool');
    expect(charges, 'nothing may have run').toEqual([]);
  }, 60_000);

  it('the tool sees the real caller, so it can refuse another tenant’s object', async () => {
    const acme = await connect('acme-token');
    const own: any = await acme.callTool({ name: 'read_invoice', arguments: { customer: 'acme-ltd' }, _meta: { idempotencyKey: 'h2' } });
    const theirs: any = await acme.callTool({ name: 'read_invoice', arguments: { customer: 'other-co' }, _meta: { idempotencyKey: 'h3' } });
    await acme.close();
    expect(JSON.stringify(own)).toContain('TR44');
    expect(JSON.stringify(theirs), 'the tool must have been able to tell').toContain('not your invoice');
    // The tool's view of the caller came from the token, not from the arguments.
    expect(invoices).toContain('acme-ltd:acme-ltd');
    expect(invoices).toContain('acme-ltd:other-co');
  }, 60_000);

  it('the same idempotencyKey from two DIFFERENT tokens does not share a record', async () => {
    // Scenario 1a, over the wire this time. Both callers may read; both send 'shared-key'.
    const before = invoices.length;
    const acme = await connect('acme-token');
    const other = await connect('other-token');
    const a: any = await acme.callTool({ name: 'read_invoice', arguments: { customer: 'acme-ltd' }, _meta: { idempotencyKey: 'shared-key' } });
    const o: any = await other.callTool({ name: 'read_invoice', arguments: { customer: 'other-co' }, _meta: { idempotencyKey: 'shared-key' } });
    await acme.close();
    await other.close();
    expect(JSON.stringify(a)).toContain('TR44');
    expect(JSON.stringify(o), 'the second caller must get its OWN answer').toContain('TR44');
    expect(invoices.length - before, 'two callers, two executions — not one cached result').toBe(2);
  }, 60_000);

  it('the same token twice under one key runs the tool once', async () => {
    const before = invoices.length;
    const acme = await connect('acme-token');
    await acme.callTool({ name: 'read_invoice', arguments: { customer: 'acme-ltd' }, _meta: { idempotencyKey: 'dedup-key' } });
    await acme.callTool({ name: 'read_invoice', arguments: { customer: 'acme-ltd' }, _meta: { idempotencyKey: 'dedup-key' } });
    await acme.close();
    expect(invoices.length - before, 'at-most-once for the effect, over HTTP').toBe(1);
  }, 60_000);

  it('the run has an owner, so a deletion request finds it over HTTP too', async () => {
    const acme = await connect('acme-token');
    await acme.callTool({ name: 'read_invoice', arguments: { customer: 'acme-ltd' }, _meta: { idempotencyKey: 'gdpr-key' } });
    await acme.close();
    const runs = await journal.listRuns();
    expect(runs.some((r: any) => r.resourceId === 'acme-ltd'), 'the journal must know whose runs these are').toBe(true);
    const deleted = await purgeResource(journal, 'acme-ltd');
    expect(deleted, 'a deletion request that finds nothing is the defect').toBeGreaterThan(0);
    const left = await journal.listRuns();
    expect(left.some((r: any) => r.resourceId === 'acme-ltd'), 'and it must be gone').toBe(false);
  }, 60_000);
});
