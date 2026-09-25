// The caller's identity comes from the transport, not from the request.
//
// Every case here was first run against the previous implementation and reproduced. Those numbers are
// in the comments, because a test that only shows the fixed behaviour cannot say what it fixed.
//
// The rule being asserted is @gnldev/durable's, not a new one: `workScope` is read from the agent's
// configuration rather than the call, because a per-call override "would put the dangerous half within
// reach of a request body". This door had handed the request body the whole identity.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, purgeResource, argsHash } from '@gnldev/durable';
import { createMcpServer, serveMcp, type McpServerOptions } from '../src/server.js';


/** Warnings matching one phrase. Counting ALL console.warn calls was brittle: this server says several
 *  different true things once each, so a test that counts them breaks when a new one is added — which is
 *  exactly what happened when `allowTool`'s warning landed. */
function warningsSaying(spy: { mock: { calls: unknown[][] } }, phrase: string): string[] {
  return spy.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(phrase));
}

/** A tool returning data that belongs to whoever asked for it, and counting its own executions. */
function invoiceTool(ran: { n: number }) {
  return {
    description: 'invoice',
    execute: async (a: any) => {
      ran.n++;
      return { customer: a.customer, iban: 'TR44 **** 9021', total: 18500 };
    },
  };
}

function chargeTool(charges: number[]) {
  return {
    description: 'charge',
    execute: async (a: any) => {
      charges.push(a.amount);
      return { charged: a.amount };
    },
  };
}

/** Identity resolved the way a real deployment would: from the token the transport validated. */
const tenantOf: McpServerOptions['identity'] = (caller) => {
  const map: Record<string, string> = { 'acme-key': 'acme-ltd', 'attacker-key': 'attacker-co' };
  const id = caller.authInfo?.clientId;
  return id && map[id] ? { resourceId: map[id] } : {};
};

describe('a reused idempotencyKey no longer reaches another caller', () => {
  it('two callers sending the SAME key get their own results, and the tool runs for each', async () => {
    // BEFORE: the attacker's call returned {"customer":"acme-ltd","iban":"TR44 **** 9021"} and `execute`
    // ran ONCE — the second caller was served the first caller's record, arguments ignored.
    const ran = { n: 0 };
    const srv = createMcpServer({ journal: new InMemoryJournal(), identity: tenantOf, tools: { get_invoice: invoiceTool(ran) } });

    const a = await srv.callTool({
      name: 'get_invoice', arguments: { customer: 'acme-ltd' },
      idempotencyKey: 'req-1', caller: { authInfo: { clientId: 'acme-key' } },
    });
    const b = await srv.callTool({
      name: 'get_invoice', arguments: { customer: 'attacker-co' },
      idempotencyKey: 'req-1', caller: { authInfo: { clientId: 'attacker-key' } },
    });

    expect(a.customer).toBe('acme-ltd');
    expect(b.customer, "the attacker must not be served the first caller's record").toBe('attacker-co');
    expect(b.iban === a.iban && b.customer === a.customer, 'identical results means the cache was shared').toBe(false);
    expect(ran.n, 'two different callers are two different units of work').toBe(2);
  });

  it('the SAME caller sending the same key twice still runs the tool once', async () => {
    // The guarantee itself. Closing the hole above by keying on the caller must not cost the dedup.
    const ran = { n: 0 };
    const srv = createMcpServer({ journal: new InMemoryJournal(), identity: tenantOf, tools: { get_invoice: invoiceTool(ran) } });
    const caller = { authInfo: { clientId: 'acme-key' } };
    const first = await srv.callTool({ name: 'get_invoice', arguments: { customer: 'acme-ltd' }, idempotencyKey: 'req-1', caller });
    const again = await srv.callTool({ name: 'get_invoice', arguments: { customer: 'acme-ltd' }, idempotencyKey: 'req-1', caller });
    expect(ran.n, 'at-most-once for the effect').toBe(1);
    expect(again).toEqual(first);
  });
});

describe('a pre-claimed key no longer suppresses somebody else’s work', () => {
  it('a guessed key from another caller does not swallow the real charge', async () => {
    // BEFORE: the attacker charged 1 under 'order-2026-0042', and the real 18500 charge returned
    // {"charged":1} without running — the caller was told it had succeeded and 1 was taken.
    const charges: number[] = [];
    const srv = createMcpServer({ journal: new InMemoryJournal(), identity: tenantOf, tools: { charge: chargeTool(charges) } });

    await srv.callTool({
      name: 'charge', arguments: { amount: 1 },
      idempotencyKey: 'order-2026-0042', caller: { authInfo: { clientId: 'attacker-key' } },
    });
    const real = await srv.callTool({
      name: 'charge', arguments: { amount: 18500 },
      idempotencyKey: 'order-2026-0042', caller: { authInfo: { clientId: 'acme-key' } },
    });

    expect(real.charged, 'the real caller must get its own result').toBe(18500);
    expect(charges, 'the attacker cannot decide what the next caller pays').toEqual([1, 18500]);
  });

  it('two different tools are different work under one key', async () => {
    // The derived id includes the tool, so one caller reusing a key across tools does not collapse them.
    const charges: number[] = [];
    const ran = { n: 0 };
    const srv = createMcpServer({
      journal: new InMemoryJournal(), identity: tenantOf,
      tools: { charge: chargeTool(charges), get_invoice: invoiceTool(ran) },
    });
    const caller = { authInfo: { clientId: 'acme-key' } };
    await srv.callTool({ name: 'charge', arguments: { amount: 500 }, idempotencyKey: 'k', caller });
    await srv.callTool({ name: 'get_invoice', arguments: { customer: 'acme-ltd' }, idempotencyKey: 'k', caller });
    expect(charges).toEqual([500]);
    expect(ran.n).toBe(1);
  });
});

describe('the run has an owner, so a deletion request can find it', () => {
  it('purgeResource finds and deletes an MCP call’s records', async () => {
    // BEFORE: listRuns() returned [{}] and purgeResource('acme-ltd') deleted 0 rows, leaving 2 behind —
    // the charge stayed in the journal with nothing saying whose it was.
    const journal = new InMemoryJournal();
    const charges: number[] = [];
    const srv = createMcpServer({ journal, identity: tenantOf, tools: { charge: chargeTool(charges) } });
    await srv.callTool({
      name: 'charge', arguments: { amount: 250 },
      idempotencyKey: 'order-1', caller: { authInfo: { clientId: 'acme-key' } },
    });

    const runs = await journal.listRuns();
    expect(runs.map((r: any) => ({ res: r.resourceId, wk: r.workKey })))
      .toEqual([{ res: 'acme-ltd', wk: 'order-1' }]);

    const deleted = await purgeResource(journal, 'acme-ltd');
    expect(deleted, 'a deletion request that deletes nothing is the defect').toBeGreaterThan(0);
    const left = (await journal.listKeys('')).filter((k: string) => !k.startsWith('__'));
    expect(left, 'nothing may survive a purge of the only caller').toEqual([]);
  });

  it('another caller’s records are not collateral', async () => {
    const journal = new InMemoryJournal();
    const srv = createMcpServer({ journal, identity: tenantOf, tools: { charge: chargeTool([]) } });
    await srv.callTool({ name: 'charge', arguments: { amount: 1 }, idempotencyKey: 'o', caller: { authInfo: { clientId: 'acme-key' } } });
    await srv.callTool({ name: 'charge', arguments: { amount: 2 }, idempotencyKey: 'o', caller: { authInfo: { clientId: 'attacker-key' } } });
    await purgeResource(journal, 'acme-ltd');
    const runs = await journal.listRuns();
    expect(runs.map((r: any) => r.resourceId), 'only the named subject is purged').toEqual(['attacker-co']);
  });
});

describe('an unattributable call is refused, not quietly run under the old key', () => {
  it('a caller the resolver cannot place gets a structured error and no side effect', async () => {
    const charges: number[] = [];
    const srv = createMcpServer({ journal: new InMemoryJournal(), identity: tenantOf, tools: { charge: chargeTool(charges) } });
    const res = await srv.callTool({
      name: 'charge', arguments: { amount: 900 },
      idempotencyKey: 'order-9', caller: { authInfo: { clientId: 'unknown-key' } },
    });
    expect(res.isError, 'a resolver that resolved nothing must not fall back to the client key').toBe(true);
    expect(res.content[0].text).toContain("Refusing to run 'charge'");
    expect(charges, 'nothing may have run').toEqual([]);
  });

  it('a call that names no work still RUNS — refusing it broke every third-party client', async () => {
    // The first version of this branch refused a call with no workKey, on the reasoning that nothing
    // would be there for a retry to find. Measured against a real SDK Client: three ordinary
    // `tools/call` requests with no `_meta` — which is what every MCP client that is not @gnldev/mcp
    // sends — were all rejected and the tool ran 0 times. That is a broken server, not a safe one.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const charges: number[] = [];
      const srv = createMcpServer({ journal: new InMemoryJournal(), identity: tenantOf, tools: { charge: chargeTool(charges) } });
      const res = await srv.callTool({ name: 'charge', arguments: { amount: 5 }, caller: { authInfo: { clientId: 'acme-key' } } });
      expect(res.isError, 'an ordinary MCP call must not be rejected').toBeUndefined();
      expect(charges).toEqual([5]);
      // Not deduped, and not silent about it.
      const said = warningsSaying(warn, 'named no unit of work');
      expect(said).toHaveLength(1);
      expect(said[0], 'the way out is named').toContain('workKey');
    } finally {
      warn.mockRestore();
    }
  });
});

// ── naming the work when the client does not ──────────────────────────────────────────────────────
// A third-party client sends no `_meta.idempotencyKey`, so there is nothing to dedupe against.
// Deriving one from the arguments is the obvious move and it is deliberately NOT the default: it also
// collapses a legitimate second purchase of the same amount, which is a domain decision. `workKey` is
// where a deployment makes it.
describe('the workKey hook', () => {
  it('lets a deployment dedupe a client that sends no key at all', async () => {
    const charges: number[] = [];
    const srv = createMcpServer({
      journal: new InMemoryJournal(),
      identity: tenantOf,
      workKey: (r) => argsHash({ name: r.name, args: r.arguments }),
      tools: { charge: chargeTool(charges) },
    });
    const caller = { authInfo: { clientId: 'acme-key' } };
    for (let i = 0; i < 3; i++) await srv.callTool({ name: 'charge', arguments: { amount: 500 }, caller });
    expect(charges, 'three identical requests, one side effect').toEqual([500]);
  });

  it('and different arguments stay different work', async () => {
    const charges: number[] = [];
    const srv = createMcpServer({
      journal: new InMemoryJournal(),
      identity: tenantOf,
      workKey: (r) => argsHash({ name: r.name, args: r.arguments }),
      tools: { charge: chargeTool(charges) },
    });
    const caller = { authInfo: { clientId: 'acme-key' } };
    await srv.callTool({ name: 'charge', arguments: { amount: 500 }, caller });
    await srv.callTool({ name: 'charge', arguments: { amount: 900 }, caller });
    expect(charges).toEqual([500, 900]);
  });

  it('the hook wins over the client\u2019s key, so the deployment decides', async () => {
    const charges: number[] = [];
    const srv = createMcpServer({
      journal: new InMemoryJournal(),
      identity: tenantOf,
      workKey: (r) => String((r.arguments as { orderId?: string } | undefined)?.orderId ?? ''),
      tools: { charge: chargeTool(charges) },
    });
    const caller = { authInfo: { clientId: 'acme-key' } };
    // Two DIFFERENT client keys, one order id: the order id is what identifies the work here.
    await srv.callTool({ name: 'charge', arguments: { amount: 500, orderId: 'o-7' }, idempotencyKey: 'a', caller });
    await srv.callTool({ name: 'charge', arguments: { amount: 500, orderId: 'o-7' }, idempotencyKey: 'b', caller });
    expect(charges).toEqual([500]);
  });
});

describe('servers built against the previous release keep working, and stop being silent', () => {
  it('no resolver → the old dedup, plus one warning naming what is not protected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ran = { n: 0 };
      const srv = createMcpServer({ journal: new InMemoryJournal(), tools: { get_invoice: invoiceTool(ran) } });
      await srv.callTool({ name: 'get_invoice', arguments: { customer: 'x' }, idempotencyKey: 'k' });
      await srv.callTool({ name: 'get_invoice', arguments: { customer: 'x' }, idempotencyKey: 'k' });
      expect(ran.n, 'the previous behaviour is unchanged').toBe(1);
      const said = warningsSaying(warn, 'a key the CLIENT chooses');
      expect(said).toHaveLength(1);
      expect(said[0], 'the warning must name the way out').toContain('identity');
      expect(said[0], 'and say where the current behaviour is correct').toContain('stdio');
    } finally {
      warn.mockRestore();
    }
  });

  it('the warning is said once per server, not once per call', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const srv = createMcpServer({ journal: new InMemoryJournal(), tools: { charge: chargeTool([]) } });
      for (let i = 0; i < 5; i++) await srv.callTool({ name: 'charge', arguments: { amount: i }, idempotencyKey: `k${i}` });
      expect(warningsSaying(warn, 'a key the CLIENT chooses'), 'a warning printed per request is a warning nobody reads').toHaveLength(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('a server with no journal does not warn — it claims no dedup to begin with', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const ran = { n: 0 };
      const srv = createMcpServer({ tools: { get_invoice: invoiceTool(ran) } });
      await srv.callTool({ name: 'get_invoice', arguments: { customer: 'x' }, idempotencyKey: 'k' });
      await srv.callTool({ name: 'get_invoice', arguments: { customer: 'x' }, idempotencyKey: 'k' });
      expect(ran.n).toBe(2);
      // The DEDUP warning is what must stay silent here — there is no journal, so nothing claimed to
      // dedupe. The `allowTool` warning is a different statement and is still true.
      expect(warningsSaying(warn, 'a key the CLIENT chooses')).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('serveMcp carries the transport’s identity, which it used to drop', () => {
  it('the SDK handler’s second parameter reaches the identity resolver', async () => {
    // The bridge took `(req)` and the SDK passes `(req, extra)`, so authInfo and sessionId never
    // arrived. Asserted over a REAL SDK Client/Server pair rather than by calling callTool directly.
    const { InMemoryTransport } = (await import('@modelcontextprotocol/sdk/inMemory.js')) as any;
    const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as any;

    const seen: unknown[] = [];
    const srv = createMcpServer({
      journal: new InMemoryJournal(),
      identity: (caller) => {
        seen.push(caller);
        return { resourceId: 'acme-ltd' };
      },
      tools: { charge: chargeTool([]) },
    });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await serveMcp(srv, st, { name: 't', version: '0' });
    const c = new Client({ name: 'c', version: '0' }, { capabilities: {} });
    await c.connect(ct);
    await c.callTool({ name: 'charge', arguments: { amount: 5 }, _meta: { idempotencyKey: 'k1' } });
    await c.close();

    expect(seen, 'the resolver must be consulted for a call arriving over the wire').toHaveLength(1);
    // An in-memory transport authenticates nobody, so the context is legitimately empty — what is
    // asserted is that it ARRIVES, as an object, rather than the resolver never being called.
    expect(typeof seen[0]).toBe('object');
  });
});
