// A failed cross-run claim must have a way back that does not mean wiping every claim.
//
// A side-effecting tool that threw is deliberately not retried: the failure may have happened AFTER
// the charge, so retrying could double it. That refusal is right. What was missing is the exit. In the
// cross-run window the claim key carries no runId, so one transient network error on order o-1 wrote
// `{status:'failed'}` under a GLOBAL key and every later attempt — any run, forever — was refused.
//
// The refusal named `approvals[<toolCallId>] = true`, which cannot be used from there: withIdempotency
// runs outside runDurable and has no approvals channel, and the toolCallId in the message is a fresh
// one each attempt, so nothing could have pre-approved it. The only documented escape was
// `journal.deletePrefix('xrun:')` — discard every cross-run dedup record to recover one order.
//
// releaseFailedClaim releases exactly one, and only when it failed. Refusing to release a SUCCEEDED
// claim is the important half: that record IS the exactly-once guarantee, and a helper that could
// remove it would be a double-charge waiting for a tired operator at 3am.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { withIdempotency, releaseFailedClaim } from '../src/idempotent-tools.js';

/** A charge that fails `failTimes` times, then succeeds. Counts REAL executions. */
function chargeTool() {
  const state = { attempts: 0, failTimes: 1 };
  const tools = {
    charge: {
      description: 'charge an order',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => {
        state.attempts++;
        if (state.attempts <= state.failTimes) throw new Error('transient network error');
        return { ok: true, attempt: state.attempts };
      },
    },
  };
  return { tools, state };
}

const call = (t: never, id: string, args: unknown) =>
  (t as { charge: { execute: (a: unknown, c: unknown) => Promise<unknown> } })
    .charge.execute(args, { toolCallId: id });

describe('releasing a failed cross-run claim', () => {
  it('the refusal is permanent until released — the behaviour that made this necessary', async () => {
    const journal = new InMemoryJournal();
    const { tools, state } = chargeTool();
    const wrap = () => withIdempotency(tools as never, { journal, window: 'cross-run' });

    await expect(call(wrap() as never, 'c1', { orderId: 'o-1' })).rejects.toThrow('transient network error');
    // A second attempt is refused — not re-run. Correct, and permanent.
    await expect(call(wrap() as never, 'c2', { orderId: 'o-1' })).rejects.toThrow(/not auto-retried after failed/);
    expect(state.attempts, 'the side effect must not have been attempted twice').toBe(1);
  });

  it('the refusal names a remedy that works from here', async () => {
    const journal = new InMemoryJournal();
    const { tools } = chargeTool();
    const wrap = () => withIdempotency(tools as never, { journal, window: 'cross-run' });
    await expect(call(wrap() as never, 'c1', { orderId: 'o-2' })).rejects.toThrow();

    const err = await call(wrap() as never, 'c2', { orderId: 'o-2' }).catch((e: Error) => e);
    // It used to point at approvals, which do not exist on this path.
    expect((err as Error).message).toContain('releaseFailedClaim');
    expect((err as Error).message).not.toContain("approvals['c2']");
  });

  it('after releasing, the same arguments run again — exactly once', async () => {
    const journal = new InMemoryJournal();
    const { tools, state } = chargeTool();
    const wrap = () => withIdempotency(tools as never, { journal, window: 'cross-run' });

    await expect(call(wrap() as never, 'c1', { orderId: 'o-3' })).rejects.toThrow();
    expect(await releaseFailedClaim(journal, { toolName: 'charge', args: { orderId: 'o-3' } })).toBe(true);

    const result = await call(wrap() as never, 'c2', { orderId: 'o-3' });
    expect(result).toMatchObject({ ok: true });
    expect(state.attempts).toBe(2); // one failure, one success

    // And the retry did not disable dedup: a further call replays rather than charging again.
    await call(wrap() as never, 'c3', { orderId: 'o-3' });
    expect(state.attempts, 'dedup stopped protecting the tool after a release').toBe(2);
  });

  it('refuses to release a SUCCEEDED claim — that record is the exactly-once guarantee', async () => {
    const journal = new InMemoryJournal();
    const { tools, state } = chargeTool();
    state.failTimes = 0; // succeeds immediately
    const wrap = () => withIdempotency(tools as never, { journal, window: 'cross-run' });

    await call(wrap() as never, 'c1', { orderId: 'o-4' });
    await expect(releaseFailedClaim(journal, { toolName: 'charge', args: { orderId: 'o-4' } }))
      .rejects.toThrow(/would let the side effect run a second time/);
  });

  it('releasing something that was never claimed is a no-op, not an error', async () => {
    const journal = new InMemoryJournal();
    expect(await releaseFailedClaim(journal, { toolName: 'charge', args: { orderId: 'never' } })).toBe(false);
  });

  it('releases only the named claim, leaving other orders\' claims intact', async () => {
    const journal = new InMemoryJournal();
    const { tools, state } = chargeTool();
    state.failTimes = Infinity; // BOTH orders must fail — otherwise the second one never gets a claim
    const wrap = () => withIdempotency(tools as never, { journal, window: 'cross-run' });

    await expect(call(wrap() as never, 'a1', { orderId: 'o-5' })).rejects.toThrow();
    // A second order also fails, so there are two poisoned records.
    await expect(call(wrap() as never, 'b1', { orderId: 'o-6' })).rejects.toThrow();

    await releaseFailedClaim(journal, { toolName: 'charge', args: { orderId: 'o-5' } });
    const remaining = (await journal.listKeys('xrun:'));
    expect(remaining.length, `deletePrefix took more than the one record: ${remaining.join(', ')}`).toBe(1);
    // ...and the survivor is still refusing, i.e. o-6 was not quietly released too.
    await expect(call(wrap() as never, 'b2', { orderId: 'o-6' })).rejects.toThrow(/not auto-retried after failed/);
  });
});
