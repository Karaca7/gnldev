// Three gates, and the sibling paths that each one has to hold on.
//
// ROOT-CAUSE HYPOTHESES (the rule being enforced, not the symptom):
//   ③ A caller must not REACH a tool it has no permission for — on any door, including the one that
//     only lists names.
//   ④ A tool must be able to tell whether the object in its arguments belongs to the caller, and must
//     not be able to be lied to about who the caller is.
//   ⑤ One caller must not exceed its share, even when every individual call is legitimate.
//
// Each block below tests the original path AND at least two siblings that violate the same rule by a
// different route: the other door, the real SDK wire, an expired window, a second caller. The sibling
// that matters most is `tools/list` — every one of these rules was first written for `tools/call`, and a
// rule written for one door is how this package has been wrong twice already.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, serverIdentityOf } from '@gnldev/durable';
import { createMcpServer, serveMcp, type McpServerOptions } from '../src/server.js';

const tenantOf: McpServerOptions['identity'] = (caller) => {
  const map: Record<string, string> = { 'acme-key': 'acme-ltd', 'other-key': 'other-co' };
  const id = caller.authInfo?.clientId;
  return id && map[id] ? { resourceId: map[id] } : {};
};
const acme = { authInfo: { clientId: 'acme-key' } };
const other = { authInfo: { clientId: 'other-key' } };

/** Permission by scope, the recipe the README gives: the token says what it may do. */
const byScope: McpServerOptions['allowTool'] = ({ name, caller }) =>
  (caller.authInfo?.scopes ?? []).includes(`tool:${name}`);

const noop = { description: 'x', execute: async () => ({ ok: 1 }) };

// ── ③ reachability ────────────────────────────────────────────────────────────────────────────────
describe('③ a caller cannot reach a tool it has no permission for', () => {
  const srv = () =>
    createMcpServer({
      journal: new InMemoryJournal(),
      identity: tenantOf,
      allowTool: byScope,
      tools: { read_invoice: noop, delete_account: noop },
    });
  const reader = { authInfo: { clientId: 'acme-key', scopes: ['tool:read_invoice'] } };

  it('ORIGINAL — the call door refuses it, indistinguishably from a tool that does not exist', async () => {
    // Was `{isError, "Not permitted: 'delete_account'"}` — which confirmed the tool exists to a caller
    // whose list was empty. See the note in callTool.
    const s = srv();
    const forbidden = await s.callTool({ name: 'delete_account', arguments: {}, idempotencyKey: 'k', caller: reader }).then(
      () => 'resolved', (e: Error) => e.message);
    const invented = await s.callTool({ name: 'no_such_thing', arguments: {}, idempotencyKey: 'k2', caller: reader }).then(
      () => 'resolved', (e: Error) => e.message);
    expect(forbidden).toBe("MCP server: no such tool: delete_account");
    expect(invented).toBe("MCP server: no such tool: no_such_thing");
  });

  it('SIBLING — a forbidden tool cannot be told apart from an invented one, on either axis', async () => {
    // Two axes leaked: the message text, and structured-error versus thrown exception. Both are pinned.
    const s = srv();
    const probe = async (name: string) => {
      try { const r: any = await s.callTool({ name, arguments: {}, idempotencyKey: `p-${name}`, caller: reader });
        return { threw: false, body: JSON.stringify(r) };
      } catch (e: any) { return { threw: true, body: e.message.replace(name, '<name>') }; }
    };
    const forbidden = await probe('delete_account');
    const invented = await probe('definitely_not_a_tool');
    expect(forbidden, 'an empty list must not be contradicted by the call door').toEqual(invented);
  });

  it('SIBLING — the LIST door does not even name it', async () => {
    // The sibling that matters. Refusing the call while listing the tool still hands the caller the
    // name and the argument schema, and puts it in front of the model as something to try.
    const { tools } = await srv().listTools({ caller: reader });
    expect(tools.map((t) => t.name)).toEqual(['read_invoice']);
  });

  it('SIBLING — the two doors agree, tool by tool', async () => {
    // Stated as a property rather than two examples: whatever the list shows must be callable, and
    // whatever it hides must not be. This is the assertion that fails if a future change teaches one
    // door a rule the other does not learn.
    const s = srv();
    const listed = new Set((await s.listTools({ caller: reader })).tools.map((t) => t.name));
    for (const name of ['read_invoice', 'delete_account']) {
      const refused = await s
        .callTool({ name, arguments: {}, idempotencyKey: `k-${name}`, caller: reader })
        .then(() => false, () => true);
      expect(refused, `list ${listed.has(name) ? 'shows' : 'hides'} '${name}' but the call ${refused ? 'refuses' : 'allows'} it`)
        .toBe(!listed.has(name));
    }
  });

  it('SIBLING — it holds over the real SDK wire, on both requests', async () => {
    const { InMemoryTransport } = (await import('@modelcontextprotocol/sdk/inMemory.js')) as any;
    const { Client } = (await import('@modelcontextprotocol/sdk/client/index.js')) as any;
    // The transport authenticates nobody, so `allowTool` sees no scopes → nothing is permitted. That
    // is the point: the filter runs on the wire path at all, which it could not before (the SDK's
    // list handler was given no caller context).
    const s = createMcpServer({ identity: tenantOf, allowTool: byScope, tools: { read_invoice: noop } });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await serveMcp(s, st, { name: 't', version: '0' });
    const c = new Client({ name: 'c', version: '0' }, { capabilities: {} });
    await c.connect(ct);
    const list = await c.listTools();
    expect(list.tools, 'an unauthenticated wire caller is shown nothing').toEqual([]);
    // Over the wire a refusal arrives as a protocol error, identical to an invented tool name — the
    // indistinguishability holds through the bridge too.
    const called = await c.callTool({ name: 'read_invoice', arguments: {} }).then(() => 'resolved', (e: Error) => e.message);
    expect(String(called)).toContain('no such tool: read_invoice');
    await c.close();
  });

  it('SIBLING — a different caller gets a different list, not a cached one', async () => {
    const s = srv();
    const admin = { authInfo: { clientId: 'acme-key', scopes: ['tool:read_invoice', 'tool:delete_account'] } };
    expect((await s.listTools({ caller: reader })).tools.map((t) => t.name)).toEqual(['read_invoice']);
    expect((await s.listTools({ caller: admin })).tools.map((t) => t.name)).toEqual(['read_invoice', 'delete_account']);
    expect((await s.listTools({ caller: reader })).tools.map((t) => t.name), 'and back again').toEqual(['read_invoice']);
  });

  it('no allowTool → the previous behaviour, said once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const s = createMcpServer({ tools: { a: noop, b: noop } });
      expect((await s.listTools()).tools).toHaveLength(2);
      await s.listTools();
      const said = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('reachable by every caller'));
      expect(said).toHaveLength(1);
      expect(said[0], 'the way out is named').toContain('allowTool');
    } finally {
      warn.mockRestore();
    }
  });
});

// ── ④ the tool can tell whose object it is ────────────────────────────────────────────────────────
describe('④ a tool can tell whether the object is the caller’s', () => {
  /** Orders and who owns them — the thing no framework layer can know. */
  const OWNER: Record<string, string> = { 'order-42': 'acme-ltd', 'order-99': 'other-co' };

  /** The tool set as a function of the sealed context: `refund` closes over the caller. */
  const tools: McpServerOptions['tools'] = (ctx) => {
    const me = serverIdentityOf(ctx).resourceId;
    return {
      refund: {
        description: 'refund',
        execute: async (a: any) => {
          if (OWNER[a.orderId] !== me) return { refused: true, reason: 'not your order' };
          return { refunded: a.orderId };
        },
      },
    };
  };

  it('ORIGINAL — its own order goes through', async () => {
    const s = createMcpServer({ journal: new InMemoryJournal(), identity: tenantOf, allowTool: () => true, tools });
    const r = await s.callTool({ name: 'refund', arguments: { orderId: 'order-42' }, idempotencyKey: 'k1', caller: acme });
    expect(r).toEqual({ refunded: 'order-42' });
  });

  it('SIBLING — somebody else’s order is refused BY THE TOOL', async () => {
    // Identity is right and permission is right; only the tool can answer this one, and now it can.
    // Measured on the previous version: `execute` received no caller at all, so this check was
    // impossible to write.
    const s = createMcpServer({ journal: new InMemoryJournal(), identity: tenantOf, allowTool: () => true, tools });
    const r: any = await s.callTool({ name: 'refund', arguments: { orderId: 'order-99' }, idempotencyKey: 'k2', caller: acme });
    expect(r.refused).toBe(true);
  });

  it('SIBLING — the caller cannot name its own subject in the request', async () => {
    // The whole reason the context is sealed. There is nothing in the request body that reaches it:
    // the arguments are data, and the reserved key is written by this server from what `identity`
    // resolved.
    let seen: unknown;
    const s = createMcpServer({
      journal: new InMemoryJournal(),
      identity: tenantOf,
      allowTool: () => true,
      tools: (ctx) => {
        seen = serverIdentityOf(ctx).resourceId;
        return { refund: noop };
      },
    });
    await s.callTool({
      name: 'refund',
      // A caller trying every spelling of "I am acme-ltd".
      arguments: { __gnl_resourceId: 'acme-ltd', resourceId: 'acme-ltd', org: 'acme-ltd' },
      idempotencyKey: 'k3',
      caller: other,
    });
    expect(seen, 'the arguments must not decide the subject').toBe('other-co');
  });

  it('SIBLING — the seal survives the spread every consumer does', async () => {
    // Pinning what the seal actually promises, after a sibling proved a claim wrong. The reserved key
    // is left WRITABLE and CONFIGURABLE on purpose (sealRequestContext's own note: nothing downstream
    // may be able to tell the difference), so the property worth asserting is not immutability — it is
    // that an ordinary `{...ctx}` in tool code still carries the subject. A seal that vanished on the
    // first spread would send tools looking for it in the request arguments instead.
    let viaSpread: unknown;
    let writable: boolean | undefined;
    const s = createMcpServer({
      identity: tenantOf,
      allowTool: () => true,
      tools: (ctx) => {
        viaSpread = serverIdentityOf({ ...ctx }).resourceId;
        writable = Object.getOwnPropertyDescriptor(ctx, '__gnl_resourceId')?.writable;
        return { refund: noop };
      },
    });
    await s.callTool({ name: 'refund', arguments: {}, idempotencyKey: 'k4', caller: other });
    expect(viaSpread, 'a copied context must still know whose it is').toBe('other-co');
    expect(writable, 'documented as writable — if this flips, the note in server.ts is wrong').toBe(true);
  });

  it('SIBLING — the LIST door seals the same context', async () => {
    // The dynamic tool set runs on both doors; a list built from an unsealed context would leak a tool
    // the caller should not see the name of.
    const subjects: unknown[] = [];
    const s = createMcpServer({
      identity: tenantOf,
      allowTool: () => true,
      tools: (ctx) => {
        subjects.push(serverIdentityOf(ctx).resourceId);
        return { refund: noop };
      },
    });
    await s.listTools({ caller: acme });
    await s.listTools({ caller: other });
    expect(subjects).toEqual(['acme-ltd', 'other-co']);
  });

  it('a static tool set still works exactly as before', async () => {
    const s = createMcpServer({ allowTool: () => true, tools: { refund: noop } });
    expect((await s.listTools()).tools.map((t) => t.name)).toEqual(['refund']);
    expect(await s.callTool({ name: 'refund', arguments: {} })).toEqual({ ok: 1 });
  });
});

// ── ⑤ one caller cannot exceed its share ──────────────────────────────────────────────────────────
describe('⑤ one caller cannot exceed its share', () => {
  const build = (rateLimit: McpServerOptions['rateLimit']) => {
    const ran: string[] = [];
    const s = createMcpServer({
      journal: new InMemoryJournal(),
      identity: tenantOf,
      allowTool: () => true,
      rateLimit,
      tools: { charge: { description: 'c', execute: async (a: any) => { ran.push(String(a.amount)); return { ok: 1 }; } } },
    });
    return { s, ran };
  };

  it('ORIGINAL — the call past the limit is refused and does not run', async () => {
    const { s, ran } = build({ maxCalls: 3, windowMs: 60_000 });
    const out: boolean[] = [];
    for (let i = 0; i < 5; i++) {
      const r: any = await s.callTool({ name: 'charge', arguments: { amount: i }, idempotencyKey: `k${i}`, caller: acme });
      out.push(r?.isError === true);
    }
    expect(out).toEqual([false, false, false, true, true]);
    expect(ran, 'a refused call must not have run').toEqual(['0', '1', '2']);
  });

  it('SIBLING — a DIFFERENT caller has its own budget', async () => {
    // Every rate limit written without a subject punishes the wrong caller. This is the sibling that
    // catches a single global counter.
    const { s, ran } = build({ maxCalls: 2, windowMs: 60_000 });
    await s.callTool({ name: 'charge', arguments: { amount: 1 }, idempotencyKey: 'a1', caller: acme });
    await s.callTool({ name: 'charge', arguments: { amount: 2 }, idempotencyKey: 'a2', caller: acme });
    const acmeThird: any = await s.callTool({ name: 'charge', arguments: { amount: 3 }, idempotencyKey: 'a3', caller: acme });
    const otherFirst: any = await s.callTool({ name: 'charge', arguments: { amount: 4 }, idempotencyKey: 'b1', caller: other });
    expect(acmeThird.isError, 'acme is out').toBe(true);
    expect(otherFirst?.isError, 'and the other caller must not pay for it').toBeUndefined();
    expect(ran).toEqual(['1', '2', '4']);
  });

  it('SIBLING — the window actually expires', async () => {
    // A limiter that never resets is an outage with a countdown. Clock moved rather than slept.
    vi.useFakeTimers();
    try {
      const { s, ran } = build({ maxCalls: 1, windowMs: 1_000 });
      await s.callTool({ name: 'charge', arguments: { amount: 1 }, idempotencyKey: 'w1', caller: acme });
      const blocked: any = await s.callTool({ name: 'charge', arguments: { amount: 2 }, idempotencyKey: 'w2', caller: acme });
      expect(blocked.isError).toBe(true);
      vi.advanceTimersByTime(1_001);
      const after: any = await s.callTool({ name: 'charge', arguments: { amount: 3 }, idempotencyKey: 'w3', caller: acme });
      expect(after?.isError, 'the window must reopen').toBeUndefined();
      expect(ran).toEqual(['1', '3']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('SIBLING — the function form lets a deployment keep its own count', async () => {
    // The built-in counter is per-process; the hook is how a cluster shares one. Asserted by using it.
    let n = 0;
    const { s, ran } = build(() => ++n <= 2);
    for (let i = 0; i < 4; i++) {
      await s.callTool({ name: 'charge', arguments: { amount: i }, idempotencyKey: `f${i}`, caller: acme });
    }
    expect(ran).toEqual(['0', '1']);
  });

  it('SIBLING — listing is not rated; only running is', async () => {
    // Discovery has no side effect, and counting it would make a client's startup handshake spend the
    // caller's budget.
    const { s } = build({ maxCalls: 1, windowMs: 60_000 });
    for (let i = 0; i < 5; i++) await s.listTools({ caller: acme });
    const r: any = await s.callTool({ name: 'charge', arguments: { amount: 9 }, idempotencyKey: 'x', caller: acme });
    expect(r?.isError, 'five listings must not have spent the one call').toBeUndefined();
  });

  it('no rateLimit → nothing is counted', async () => {
    const { s, ran } = build(undefined);
    for (let i = 0; i < 20; i++) await s.callTool({ name: 'charge', arguments: { amount: i }, idempotencyKey: `n${i}`, caller: acme });
    expect(ran).toHaveLength(20);
  });
});

// ── gate interactions ─────────────────────────────────────────────────────────────────────────────
// Three gates in a row have pairs, and the pairs were untested until a standalone smoke test against
// the built `dist` failed on one of them. (That failure was the smoke script's own limit being too low
// for the calls it made — but it pointed straight at an interaction nothing here covered.)
describe('the gates do not damage each other', () => {
  const build = (rateLimit: McpServerOptions['rateLimit'], allowTool: McpServerOptions['allowTool'] = () => true) => {
    const ran: number[] = [];
    const journal = new InMemoryJournal();
    const s = createMcpServer({
      journal,
      identity: () => ({ resourceId: 'acme-ltd' }),
      allowTool,
      rateLimit,
      tools: {
        ok_tool: { description: 'o', execute: async (a: any) => { ran.push(a.n); return { ok: 1 }; } },
        no_tool: { description: 'n', execute: async () => ({ ok: 1 }) },
      },
    });
    return { s, ran, journal };
  };
  const keys = async (j: InMemoryJournal) => (await j.listKeys('')).filter((k: string) => !k.startsWith('__')).length;

  it('a rate-limited call leaves NO journal record, so the retry is not poisoned', async () => {
    // The dangerous version of this: the refusal writes a claim, the caller waits for the window, and
    // the retry is then told the work was already done. The side effect would never run and nobody
    // would be told. Measured: 3 keys before the refusal, 3 after, and the retry executes.
    vi.useFakeTimers();
    try {
      const { s, ran, journal } = build({ maxCalls: 1, windowMs: 1_000 });
      await s.callTool({ name: 'ok_tool', arguments: { n: 1 }, idempotencyKey: 'k1', caller: acme });
      const before = await keys(journal);
      const blocked: any = await s.callTool({ name: 'ok_tool', arguments: { n: 2 }, idempotencyKey: 'k2', caller: acme });
      expect(blocked.isError).toBe(true);
      expect(await keys(journal), 'a refused call must journal nothing').toBe(before);
      vi.advanceTimersByTime(1_001);
      const retry: any = await s.callTool({ name: 'ok_tool', arguments: { n: 2 }, idempotencyKey: 'k2', caller: acme });
      expect(retry?.isError, 'the same key must still be usable').toBeUndefined();
      expect(ran, 'and the work it names must actually run').toEqual([1, 2]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a permission refusal does NOT spend the rate budget', async () => {
    // Order matters and this pins it: permission is checked before the counter, so probing for tools it
    // may not call cannot exhaust a caller's own allowance. The reverse order would let one caller
    // burn its budget on refusals and then be unable to do its actual work.
    const { s, ran } = build({ maxCalls: 2, windowMs: 60_000 }, ({ name }) => name === 'ok_tool');
    for (let i = 0; i < 3; i++) {
      const refused = await s
        .callTool({ name: 'no_tool', arguments: {}, idempotencyKey: `n${i}`, caller: acme })
        .then(() => false, () => true);
      expect(refused).toBe(true);
    }
    const a: any = await s.callTool({ name: 'ok_tool', arguments: { n: 1 }, idempotencyKey: 'o1', caller: acme });
    const b: any = await s.callTool({ name: 'ok_tool', arguments: { n: 2 }, idempotencyKey: 'o2', caller: acme });
    expect(a?.isError).toBeUndefined();
    expect(b?.isError).toBeUndefined();
    expect(ran).toEqual([1, 2]);
  });

  it('a permission refusal reveals nothing about the arguments', async () => {
    // Permission before argument validation. A caller that may not reach a tool must not be able to
    // map its schema by reading which field the server complained about.
    const s = createMcpServer({
      allowTool: () => false,
      tools: {
        secret: {
          description: 's',
          inputSchema: { safeParse: () => ({ success: false, error: { issues: [{ path: ['apiKey'], message: 'required' }] } }) } as any,
          execute: async () => ({ ok: 1 }),
        },
      },
    });
    const msg = await s.callTool({ name: 'secret', arguments: {} }).then(() => 'resolved', (e: Error) => e.message);
    expect(msg, 'the schema must not leak through the refusal').not.toContain('apiKey');
    expect(msg).toBe('MCP server: no such tool: secret');
  });
});

// ── the rate limiter's own bookkeeping ────────────────────────────────────────────────────────────
// Its window table only ever REPLACED an entry, and only when the same subject came back — so a subject
// that never returned kept its row forever. Measured with the journal excluded: 20,000 distinct
// subjects cost 2.09 MB (~104 bytes each) and letting every window expire freed none of it. Per-tenant
// subjects are a few thousand rows; per-PERSON subjects — which is what durable's default
// `scopeKind: 'resource'` means in most deployments — are as many rows as there are people.
describe('the rate limiter does not grow without bound', () => {
  const build = (windowMs: number) => {
    let n = 0;
    const ran: string[] = [];
    const s = createMcpServer({
      identity: (c) => ({ resourceId: (c as { authInfo?: { clientId?: string } }).authInfo?.clientId ?? `gen-${n++}` }),
      allowTool: () => true,
      rateLimit: { maxCalls: 2, windowMs },
      tools: { t: { description: 't', execute: async (a: any) => { ran.push(String(a.n)); return { ok: 1 }; } } },
    });
    return { s, ran };
  };

  it('THE DANGEROUS HALF — a sweep must never evict a LIVE window', async () => {
    // The sweep is what stops the growth, and evicting the wrong row is worse than the leak: a fresh
    // allowance is the limit not holding. Over 1024 one-shot subjects push the table past the sweep
    // threshold while one real caller's window stays live.
    const { s, ran } = build(60_000);
    const live = { authInfo: { clientId: 'acme-key' } };
    await s.callTool({ name: 't', arguments: { n: 'a1' }, idempotencyKey: 'a1', caller: live });
    await s.callTool({ name: 't', arguments: { n: 'a2' }, idempotencyKey: 'a2', caller: live });
    // 1500 distinct one-shot subjects — crosses the sweep threshold several times over.
    for (let i = 0; i < 1500; i++) await s.callTool({ name: 't', arguments: { n: `x${i}` }, idempotencyKey: `x${i}`, caller: {} });
    const third: any = await s.callTool({ name: 't', arguments: { n: 'a3' }, idempotencyKey: 'a3', caller: live });
    expect(third.isError, 'the live caller is still out of budget after the sweep').toBe(true);
    expect(ran.filter((r) => r.startsWith('a')), 'and its allowance was not reset').toEqual(['a1', 'a2']);
  }, 120_000);

  it('an expired window is reclaimed, and the subject starts fresh', async () => {
    vi.useFakeTimers();
    try {
      const { s, ran } = build(1_000);
      const c = { authInfo: { clientId: 'acme-key' } };
      await s.callTool({ name: 't', arguments: { n: '1' }, idempotencyKey: '1', caller: c });
      await s.callTool({ name: 't', arguments: { n: '2' }, idempotencyKey: '2', caller: c });
      expect((await s.callTool({ name: 't', arguments: { n: '3' }, idempotencyKey: '3', caller: c }) as any).isError).toBe(true);
      vi.advanceTimersByTime(1_001);
      const after: any = await s.callTool({ name: 't', arguments: { n: '4' }, idempotencyKey: '4', caller: c });
      expect(after?.isError).toBeUndefined();
      expect(ran).toEqual(['1', '2', '4']);
    } finally {
      vi.useRealTimers();
    }
  });

  // NOT TESTED, and not pretended otherwise: that the sweep actually reclaims memory.
  //
  // A heap assertion was written here and removed for failing both directions of the mutation check.
  // With the sweep deleted it still PASSED (so it caught nothing), and on the way back it FAILED at
  // 16.3 MB for 30,000 one-shot subjects — the reading is dominated by the calls themselves and by GC
  // timing, not by a table worth ~104 bytes a row. A test that cannot tell the fix from its absence is
  // worse than no test, because it reads like coverage.
  //
  // A SOAK PROTOCOL WAS TRIED TOO, and it failed the same way — recorded so nobody repeats it. Ten equal
  // batches of 5,000 one-shot subjects on a 1 ms window, heap sampled after each, growth compared between
  // the first three batches and the last three, run twice: once with the sweep and once with it mutated
  // out. The two series are indistinguishable (~2-3 MB per batch either way, with GC dropping 13 MB at
  // arbitrary points), because 5,000 rows at ~104 bytes is half a megabyte inside a batch that allocates
  // four times that just making the calls.
  //
  // So the leak IS measured, once, in isolation (journal excluded, one before/after pair): 20,000 distinct
  // subjects cost 2.09 MB and expiring every window freed none of it. That number is in `sweepWindows`'s
  // note. It is not a regression test, and pretending otherwise with a heap threshold was tried and
  // reverted. The half that could go WRONG — evicting a live window — is tested above, and a mutation
  // confirms it; the sweep is safe whether or not the saving is large, because deleting an expired row
  // changes no behaviour.

});

// ── concurrency: the guarantee holds, and the caller is told the truth about it ────────────────────
// Concurrent calls under one key are the NORMAL case on this door — a double-click, a client retrying on
// timeout, two workers draining one queue — unlike inside `runDurable`, where a run is sequential.
describe('concurrent calls under one key', () => {
  const slowCharge = (ran: number[]) => ({
    description: 'charge',
    execute: async (a: any) => { await new Promise((r) => setTimeout(r, 20)); ran.push(a.amount); return { charged: a.amount }; },
  });

  it('the side effect runs exactly ONCE for 10 parallel calls', async () => {
    const ran: number[] = [];
    const s = createMcpServer({
      journal: new InMemoryJournal(), identity: tenantOf, allowTool: () => true,
      tools: { charge: slowCharge(ran) },
    });
    await Promise.all(Array.from({ length: 10 }, () =>
      s.callTool({ name: 'charge', arguments: { amount: 500 }, idempotencyKey: 'SAME', caller: acme })));
    expect(ran, 'at-most-once under concurrency').toEqual([500]);
  }, 60_000);

  it('and the nine that lost the race get a STRUCTURED, retryable answer — not a raw throw', async () => {
    // Measured before this: one caller got `{charged:500}` and nine got a thrown `RunBusyError` through
    // the protocol, which reads as "your call failed" for work that had succeeded. `@gnldev/server`
    // already mapped `run_busy` to 409 + resumable:true from `blockedErrorCode`, the one source of truth
    // for these names; this door was the surface not using it.
    const ran: number[] = [];
    const s = createMcpServer({
      journal: new InMemoryJournal(), identity: tenantOf, allowTool: () => true,
      tools: { charge: slowCharge(ran) },
    });
    const results = await Promise.all(Array.from({ length: 10 }, () =>
      s.callTool({ name: 'charge', arguments: { amount: 500 }, idempotencyKey: 'SAME2', caller: acme })
        .then((r: any) => r, (e: Error) => ({ threw: e.message }))));
    const threw = results.filter((r: any) => r.threw);
    const structured = results.filter((r: any) => r.isError === true);
    const succeeded = results.filter((r: any) => r.charged === 500);
    // The invariant, not the split: how many lose the race is a fact about TIMING (a loaded machine
    // lets the tool finish before some calls arrive, and those read the completed record — dedup
    // working, counted as a success). The example's copy of this assertion went red in a full-suite run
    // at exactly that. What must hold anywhere: nothing thrown, somebody got the result, and every
    // caller got one answer or the other.
    expect(threw, 'nothing may escape as a transport-level exception').toEqual([]);
    expect(succeeded.length, 'somebody must receive the result').toBeGreaterThanOrEqual(1);
    expect(succeeded.length + structured.length, 'and every caller gets one answer or the other').toBe(10);
    expect(structured.length, 'at least one caller must have taken the retryable path').toBeGreaterThanOrEqual(1);
    const text = (structured[0] as any).content[0].text;
    expect(text, 'the code the rest of the suite already uses').toContain('[run_busy]');
    expect(text, 'and it must say retrying is how you collect the result').toContain('SAME idempotencyKey');
    expect(text, 'and that nothing ran twice').toContain('NOT been run twice');
    expect(ran).toEqual([500]);
  }, 60_000);

  it('retrying after the race collects the result without running again', async () => {
    const ran: number[] = [];
    const s = createMcpServer({
      journal: new InMemoryJournal(), identity: tenantOf, allowTool: () => true,
      tools: { charge: slowCharge(ran) },
    });
    const [first, second] = await Promise.all([
      s.callTool({ name: 'charge', arguments: { amount: 7 }, idempotencyKey: 'RACE', caller: acme }),
      s.callTool({ name: 'charge', arguments: { amount: 7 }, idempotencyKey: 'RACE', caller: acme }),
    ]);
    const loser: any = (first as any).isError ? first : second;
    expect(loser.isError, 'one of the two must have lost').toBe(true);
    const retry: any = await s.callTool({ name: 'charge', arguments: { amount: 7 }, idempotencyKey: 'RACE', caller: acme });
    expect(retry?.isError, 'the advice the message gives must actually work').toBeUndefined();
    expect(retry).toEqual({ charged: 7 });
    expect(ran, 'and the retry must not be a second charge').toEqual([7]);
  }, 60_000);

  it('different keys in parallel all run — the lock is per unit of work', async () => {
    const ran: number[] = [];
    const s = createMcpServer({
      journal: new InMemoryJournal(), identity: tenantOf, allowTool: () => true,
      tools: { charge: slowCharge(ran) },
    });
    await Promise.all(Array.from({ length: 10 }, (_, i) =>
      s.callTool({ name: 'charge', arguments: { amount: i }, idempotencyKey: `K${i}`, caller: acme })));
    expect(ran.sort((x, y) => x - y)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  }, 60_000);
});
