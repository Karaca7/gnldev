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
    // Two records remain, not one: a release is now a compare-and-set to a 'released' tombstone rather
    // than a deletion (see releaseFailedClaim). o-5's record still exists, it just no longer refuses.
    const remaining = (await journal.listKeys('xrun:'));
    expect(remaining.length, `the release touched more than its own record: ${remaining.join(', ')}`).toBe(2);
    const released = await journal.get(remaining.find((k) => k.includes('charge'))!) as { status?: string };
    expect(released?.status).toBeDefined();
    // ...and the survivor is still refusing, i.e. o-6 was not quietly released too.
    await expect(call(wrap() as never, 'b2', { orderId: 'o-6' })).rejects.toThrow(/not auto-retried after failed/);
  });

  it('refuses to release a claim that SUCCEEDED while it was being released', async () => {
    // The double charge this prevents, reproduced. The first version read the record, saw 'failed', then
    // deleted — and a concurrent retry can succeed in that gap. Deleting then removes a SUCCEEDED claim,
    // so the next call runs the side effect again. Measured before the fix: 3 real charges where 2 were
    // correct. The tool is `idempotent: true` because that is what makes an automatic retry possible at
    // all; without it nothing could have raced.
    const journal = new InMemoryJournal();
    let charges = 0;
    const tools = {
      charge: {
        description: 'charge an order',
        inputSchema: z.object({ orderId: z.string() }),
        idempotent: true,
        execute: async () => { charges++; if (charges === 1) throw new Error('transient'); return { ok: true }; },
      },
    };
    const wrap = () => withIdempotency(tools as never, { journal, window: 'cross-run' });
    const fire = (id: string) => call(wrap() as never, id, { orderId: 'o-race' });

    await fire('c1').catch(() => {});                     // fails → the claim says 'failed'
    // Slip a successful retry between releaseFailedClaim's read and its write.
    const realGet = journal.get.bind(journal);
    (journal as { get: unknown }).get = async (k: string) => {
      const v = await realGet(k);
      if (k.startsWith('xrun:')) { (journal as { get: unknown }).get = realGet; await fire('c2'); }
      return v;
    };

    await expect(releaseFailedClaim(journal, { toolName: 'charge', args: { orderId: 'o-race' } }))
      .rejects.toThrow(/changed while it was being released/);

    await fire('c3'); // must replay the success, not charge again
    expect(charges, 'the release destroyed a succeeded claim and the side effect ran twice').toBe(2);
  });

  it('needs a journal that can compare-and-set, and says so rather than racing', async () => {
    // Fail closed: without putIfMatch the release cannot distinguish a still-failed claim from one that
    // just succeeded, and doing it anyway is the double charge above.
    const journal = new InMemoryJournal();
    await journal.put('xrun:args-charge-x', { status: 'failed' });
    const noCas = { get: journal.get.bind(journal), put: journal.put.bind(journal) };
    await expect(releaseFailedClaim(noCas as never, { toolName: 'charge', args: { orderId: 'o-7' } }))
      .rejects.toThrow(/putIfMatch/);
  });
});
