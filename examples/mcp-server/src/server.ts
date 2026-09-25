// A multi-tenant MCP server, exposed over real HTTP.
//
// Everything here answers one of five questions, and they are NOT the same question. Getting the first
// one right tells you nothing about the rest:
//
//   ① is this token real?          YOUR code (below, in `startServer`) — never GNL's
//   ② who is calling?              `identity`
//   ③ may they call this tool?     `allowTool`   — applied to tools/list AND tools/call
//   ④ is this object theirs?       the TOOL, closing over the sealed caller context
//   ⑤ are they calling too much?   `rateLimit`
//
// ① is yours because the MCP spec puts it there: authorization is OPTIONAL, an STDIO implementation
// SHOULD NOT follow it (credentials come from the environment), and for HTTP the server must validate
// that a token was issued for IT as the audience. `serveMcp` never opens this socket, so it cannot do
// any of that — it reads what your transport already validated, from `extra.authInfo`.
import { createServer, type IncomingMessage, type Server as HttpServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { InMemoryJournal, serverIdentityOf, argsHash, type Journal } from '@gnldev/durable';
import { createMcpServer, serveMcp } from '@gnldev/mcp';

/** ① The deployment's own token table. GNL never sees this — a real one is an OAuth introspection or a JWT verify. */
const TOKENS: Record<string, { clientId: string; scopes: string[] }> = {
  'acme-token': { clientId: 'acme-key', scopes: ['tool:read_invoice', 'tool:refund'] },
  'globex-token': { clientId: 'globex-key', scopes: ['tool:read_invoice', 'tool:refund'] },
  'reporting-token': { clientId: 'reporting-key', scopes: ['tool:read_invoice'] },
};

/** ② The mapping from a validated credential to a SUBJECT. By the time this runs, the token is already valid. */
const TENANT: Record<string, string> = {
  'acme-key': 'acme-ltd',
  'globex-key': 'globex-inc',
  'reporting-key': 'acme-ltd', // the reporting integration acts for acme, with fewer scopes
};

/** The business data no framework layer can reason about — which is exactly why ④ belongs to the tool. */
const INVOICES: Record<string, { tenant: string; total: number; iban: string }> = {
  'inv-1': { tenant: 'acme-ltd', total: 18_500, iban: 'TR44 **** 9021' },
  'inv-2': { tenant: 'globex-inc', total: 4_200, iban: 'TR33 **** 7710' },
};

export interface RunningServer {
  url: string;
  journal: Journal;
  /** What actually executed, in order — the demo and the test both read this. */
  effects: string[];
  /** Live MCP sessions. Watched so the example can assert it does not leak. */
  sessionCount: () => number;
  /** Drop sessions idle longer than the configured window, as a request would. Exposed so the test can
   *  advance the clock instead of waiting on one. */
  sweepIdleSessions: (now?: number) => number;
  close: () => Promise<void>;
}

export interface ServerOptions {
  /** How long a session may go untouched before it is dropped. Short here so the example can show it. */
  sessionIdleMs?: number;
}

export async function startServer(opts: ServerOptions = {}): Promise<RunningServer> {
  const { StreamableHTTPServerTransport } = await import('@modelcontextprotocol/sdk/server/streamableHttp.js');
  const journal = new InMemoryJournal();
  const effects: string[] = [];

  const mcp = createMcpServer({
    journal,

    // ② From the transport, never the request body. @gnldev/durable makes the same choice for `workScope`,
    // and says why: a per-call override "would put the dangerous half within reach of a request body".
    identity: (caller) => {
      const tenant = TENANT[caller.authInfo?.clientId ?? ''];
      return tenant ? { resourceId: tenant, actor: caller.authInfo?.clientId } : {};
    },

    // ③ The spec's own mechanism — the token says what it may do. Applied to BOTH doors, so a tool this
    // caller may not run is a tool it does not see in tools/list, and the call door does not contradict
    // that by confirming the tool exists.
    allowTool: ({ name, caller }) => (caller.authInfo?.scopes ?? []).includes(`tool:${name}`),

    // ⑤ Per caller, in this process. A deployment behind a load balancer passes a function instead and
    // keeps the counter where its other counters live.
    rateLimit: { maxCalls: 50, windowMs: 60_000 },

    // A third-party MCP client sends no `_meta.idempotencyKey`; @gnldev/mcp's own client does. Without a
    // key there is nothing to dedupe against, and what counts as "the same work" is a domain question —
    // so it is answered here rather than guessed by the library.
    workKey: (req) => argsHash({ name: req.name, args: req.arguments }),

    // ④ The tool set is built PER CALL from the sealed context, so each tool closes over whose call it is.
    // A static tool set cannot do this: it receives arguments and no caller, so `refund({ invoiceId })`
    // would have nothing to compare the invoice against.
    tools: (ctx) => {
      const me = serverIdentityOf(ctx).resourceId;
      const mine = (id: string) => INVOICES[id]?.tenant === me;
      return {
        read_invoice: {
          description: 'Read one of your own invoices',
          execute: async ({ invoiceId }: { invoiceId: string }) => {
            effects.push(`read_invoice ${me} -> ${invoiceId}`);
            // The check GNL cannot make for you, and can now make possible.
            if (!mine(invoiceId)) return { error: 'not your invoice' };
            return INVOICES[invoiceId];
          },
        },
        refund: {
          description: 'Refund one of your own invoices',
          execute: async ({ invoiceId }: { invoiceId: string }) => {
            // Slow on purpose: it widens the window two concurrent callers race in, which is the case
            // this example exists to show is safe.
            await new Promise((r) => setTimeout(r, 25));
            effects.push(`refund ${me} -> ${invoiceId}`);
            if (!mine(invoiceId)) return { error: 'not your invoice' };
            return { refunded: invoiceId, amount: INVOICES[invoiceId].total };
          },
        },
      };
    },
  });

  // ── The HTTP host. Yours, not GNL's. ────────────────────────────────────────────────────────────
  //
  // SESSIONS NEED A TIMEOUT, NOT JUST A CLOSE HOOK — and that is the point of this block.
  //
  // The SDK's own examples keep a `Map` of transports by session id. Kept without a matching delete it
  // grows one entry per client that ever connected, for the lifetime of the process. The obvious fix is
  // `onsessionclosed`, and it is necessary but NOT sufficient. Measured against this very server:
  //
  //   client.close()            → the server STILL holds the session   (1 → 1)
  //   client.terminateSession() → the session is dropped               (2 → 1)
  //
  // `close()` closes the CLIENT's transport; the DELETE that ends the server-side session is a separate
  // call (`terminateSession`). So an orderly goodbye is opt-in on the client, which means a client that
  // simply disconnects — or crashes, or loses the network — never sends one. A server that cleans up only
  // on the hook leaks every one of those.
  //
  // Hence the hook for the orderly case AND an idle sweep for every other case. The sweep runs on request
  // rather than on a timer, so an idle process does not hold a handle open.
  //
  // A `transport.onclose` handler was here too and was REMOVED, because a mutation showed it earning
  // nothing: deleting it broke no test, and deleting `onsessionclosed` instead broke none either — for
  // the orderly path they are interchangeable, since a DELETE both closes the session and closes the
  // transport. The case it was added for is the client that vanishes, and the measurement above is
  // exactly the case where it does NOT fire. Two hooks read as belt-and-braces and were one hook plus a
  // decoration; only removing BOTH broke a test, which is how that was found.
  const IDLE_MS = opts.sessionIdleMs ?? 5 * 60_000;
  const sessions = new Map<string, { transport: any; lastSeen: number }>();

  function sweepIdleSessions(now: number = Date.now()): number {
    let dropped = 0;
    for (const [id, entry] of sessions) {
      if (now - entry.lastSeen <= IDLE_MS) continue;
      sessions.delete(id);
      dropped++;
      // Close the transport as well as forgetting it: dropping the reference alone leaves the SDK's own
      // per-session state alive until GC, and any stream it holds open.
      void Promise.resolve(entry.transport.close?.()).catch(() => {});
    }
    return dropped;
  }

  const http: HttpServer = createServer(async (req, res) => {
    // ① Validate, then publish the RESULT on the request. The SDK carries `req.auth` through to the
    // handler as `extra.authInfo`, which is the only thing that can say who is calling.
    const bearer = (req.headers.authorization ?? '').replace(/^Bearer\s+/i, '');
    const token = TOKENS[bearer];
    if (!token) {
      res.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end();
      return;
    }
    (req as IncomingMessage & { auth?: unknown }).auth = { token: bearer, clientId: token.clientId, scopes: token.scopes };

    sweepIdleSessions();

    const sid = req.headers['mcp-session-id'] as string | undefined;
    const existing = sid ? sessions.get(sid) : undefined;
    let transport = existing?.transport;
    if (existing) existing.lastSeen = Date.now();
    if (!transport) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id: string) => {
          sessions.set(id, { transport, lastSeen: Date.now() });
        },
        onsessionclosed: (id: string) => {
          sessions.delete(id);
        },
      });
      await serveMcp(mcp, transport, { name: 'invoices', version: '1.0.0' });
    }
    await transport.handleRequest(req, res);
  });

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  const { port } = http.address() as { port: number };
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    journal,
    effects,
    sessionCount: () => sessions.size,
    sweepIdleSessions,
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  };
}

/** A real MCP client over real HTTP, carrying a real Bearer token. */
export async function connect(url: string, token: string) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const client = new Client({ name: 'example-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }),
  );
  return client;
}
