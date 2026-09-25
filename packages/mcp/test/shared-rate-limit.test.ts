// The rate limit across MORE THAN ONE PROCESS, which the built-in counter cannot do.
//
// `rateLimit: { maxCalls, windowMs }` counts in one process: two instances behind a load balancer each
// allow `maxCalls`, so the effective limit is N times what the operator wrote. The type says so and the
// README says so, and that was the whole of it — an escape hatch nobody had used is a claim, not a way out.
//
// This is the way out, exercised: `rateLimit` also takes a FUNCTION, and @gnldev/durable's journal already
// carries the primitive for a shared counter — `incrBy` is atomic on every real storage (Redis
// HINCRBYFLOAT, Postgres/SQLite UPSERT arithmetic), which is why `budget.ts` uses it for the same kind of
// bookkeeping. Nothing new is added to this package for it.
//
// Two servers share one journal below, which is the shape two processes have. What the test would look
// like if the limit did NOT hold: each server allowing its own `maxCalls`, so 2× the intended number of
// side effects — asserted directly, against the built-in, so the comparison has a baseline that
// reproduces the problem.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, type Journal } from '@gnldev/durable';
import { createMcpServer, type McpServerOptions } from '../src/server.js';

/**
 * A rate limit every instance shares, as a `rateLimit` function.
 *
 * The window is derived from the clock rather than stored, so two processes agree on which bucket they are
 * in without coordinating. `incrBy` then `getCounters` is two operations, and a concurrent caller can make
 * the read return a number higher than this call's own increment — which refuses a call that a perfectly
 * serialised counter would have allowed. That is the direction to err in: a limiter that occasionally
 * refuses one call too early is a limiter; one that occasionally allows one too many is not.
 */
function sharedRateLimit(journal: Journal, opts: { maxCalls: number; windowMs: number }): McpServerOptions['rateLimit'] {
  return async ({ identity }) => {
    const subject = identity.resourceId ?? identity.orgId ?? '__anonymous';
    const bucket = Math.floor(Date.now() / opts.windowMs);
    const key = `__ratelimit:${subject}:${bucket}`;
    await journal.incrBy!(key, { calls: 1 });
    const counters = await journal.getCounters!(key);
    return (counters?.calls ?? 0) <= opts.maxCalls;
  };
}

const caller = { authInfo: { clientId: 'acme-key' } };
const otherCaller = { authInfo: { clientId: 'globex-key' } };
const TENANT: Record<string, string> = { 'acme-key': 'acme-ltd', 'globex-key': 'globex-inc' };
const identity: McpServerOptions['identity'] = (c) => ({ resourceId: TENANT[c.authInfo?.clientId ?? ''] });

/** Two servers on ONE journal — the shape two processes behind a load balancer have. */
function twoInstances(rateLimit: (j: Journal) => McpServerOptions['rateLimit']) {
  const journal = new InMemoryJournal();
  const ran: number[] = [];
  const make = () =>
    createMcpServer({
      journal,
      identity,
      allowTool: () => true,
      rateLimit: rateLimit(journal),
      tools: { charge: { description: 'c', execute: async (a: any) => { ran.push(a.n); return { ok: 1 }; } } },
    });
  return { a: make(), b: make(), ran, journal };
}

describe('a rate limit shared across instances', () => {
  it('the in-memory journal carries the primitive this needs', () => {
    // Stated as its own assertion because the whole recipe rests on it, and `incrBy`/`getCounters` are
    // OPTIONAL members of Journal — a custom storage may not have them, and then this recipe is not
    // available on it.
    const j = new InMemoryJournal();
    expect(typeof j.incrBy, 'incrBy is what makes the count atomic').toBe('function');
    expect(typeof j.getCounters).toBe('function');
  });

  it('BASELINE — the built-in counter lets each instance allow its own quota', async () => {
    // The defect this exists to fix, reproduced. Without a baseline that reproduces it, the next test
    // proves only that some number came out.
    const { a, b, ran } = twoInstances(() => ({ maxCalls: 3, windowMs: 60_000 }));
    for (let i = 0; i < 5; i++) await a.callTool({ name: 'charge', arguments: { n: i }, idempotencyKey: `a${i}`, caller });
    for (let i = 0; i < 5; i++) await b.callTool({ name: 'charge', arguments: { n: 10 + i }, idempotencyKey: `b${i}`, caller });
    expect(ran.length, 'two instances, 3 each — the operator asked for 3 in total').toBe(6);
  }, 60_000);

  it('the shared counter holds one quota across both', async () => {
    const { a, b, ran } = twoInstances((j) => sharedRateLimit(j, { maxCalls: 3, windowMs: 60_000 }));
    for (let i = 0; i < 5; i++) await a.callTool({ name: 'charge', arguments: { n: i }, idempotencyKey: `a${i}`, caller });
    for (let i = 0; i < 5; i++) await b.callTool({ name: 'charge', arguments: { n: 10 + i }, idempotencyKey: `b${i}`, caller });
    expect(ran.length, 'three calls in total, whichever instance they arrived at').toBe(3);
    // And they are the FIRST three, so the limit refuses later calls rather than arbitrary ones.
    expect(ran).toEqual([0, 1, 2]);
  }, 60_000);

  it('a different subject has its own quota, on both instances', async () => {
    // One bucket per subject is what keeps tenants from spending each other's allowance. The first
    // version of this test built a third server out of `undefined as never` and asserted nothing about
    // the second subject at all — it passed, which is why it was replaced rather than kept.
    const { a, b, ran } = twoInstances((j) => sharedRateLimit(j, { maxCalls: 2, windowMs: 60_000 }));
    for (let i = 0; i < 3; i++) await a.callTool({ name: 'charge', arguments: { n: i }, idempotencyKey: `x${i}`, caller });
    expect(ran, 'acme gets two and is then out').toEqual([0, 1]);

    // globex arrives at the OTHER instance, and must still have its full allowance.
    const first: any = await b.callTool({ name: 'charge', arguments: { n: 100 }, idempotencyKey: 'g1', caller: otherCaller });
    const second: any = await b.callTool({ name: 'charge', arguments: { n: 101 }, idempotencyKey: 'g2', caller: otherCaller });
    const third: any = await b.callTool({ name: 'charge', arguments: { n: 102 }, idempotencyKey: 'g3', caller: otherCaller });
    expect(first?.isError, 'globex has not spent anything').toBeUndefined();
    expect(second?.isError).toBeUndefined();
    expect(third?.isError, 'and is subject to the same limit, not a bigger one').toBe(true);
    expect(ran).toEqual([0, 1, 100, 101]);
  }, 60_000);

  it('the window reopens, and both instances see it reopen', async () => {
    const { a, b, ran, journal } = twoInstances((j) => sharedRateLimit(j, { maxCalls: 1, windowMs: 1_000 }));
    await a.callTool({ name: 'charge', arguments: { n: 1 }, idempotencyKey: 'w1', caller });
    const blockedOnB: any = await b.callTool({ name: 'charge', arguments: { n: 2 }, idempotencyKey: 'w2', caller });
    expect(blockedOnB.isError, 'the second instance must see the first one’s count').toBe(true);

    // The bucket is derived from the clock, so moving past the window is enough — no shared state to reset.
    const keysBefore = (await journal.listKeys!('__ratelimit:')).length;
    await new Promise((r) => setTimeout(r, 1_050));
    const after: any = await b.callTool({ name: 'charge', arguments: { n: 3 }, idempotencyKey: 'w3', caller });
    expect(after?.isError, 'and it must reopen for both').toBeUndefined();
    expect(ran).toEqual([1, 3]);
    // A clock-derived bucket means old keys are inert rather than wrong — but they are not free, which is
    // the trade against the in-process version's sweep.
    expect((await journal.listKeys!('__ratelimit:')).length).toBeGreaterThan(keysBefore);
  }, 60_000);
});
