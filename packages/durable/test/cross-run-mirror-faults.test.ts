// The shadow record is a CONVENIENCE. It must never be able to cost correctness.
//
// `mirrorUnderRun` gives a cross-run tool step a copy under the run's own prefix, so the run has a
// timeline and the operator has something to click. It is written from `writeToolTerminal`, which runs
// inside the try that wraps the tool body — and that try's catch records `{status:'failed'}`.
//
// So an unguarded mirror write turned an infrastructure blip into a double charge. Measured with one
// injected put rejection on the mirror key: the authoritative record went from `succeeded` to
// `failed`, and the next approved attempt ran the side effect a SECOND time. Without an approval the
// other outcome is quieter and worse — the cross-run claim is poisoned globally and permanently, and
// the remedy the refusal names (releaseFailedClaim, "once you have established the side effect did
// not happen") cannot be used, because it did happen.
//
// Failure classes this covers are ordinary for the backends this framework targets: a Postgres
// connection reset, a Redis timeout, ENOSPC.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { withIdempotency } from '../src/idempotent-tools.js';
import { gnlTool } from '../src/types.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** A journal whose writes to the RUN-SCOPED mirror key fail, while every other write succeeds. */
class MirrorHostileJournal extends InMemoryJournal {
  mirrorAttempts = 0;
  override async put(key: string, value: unknown): Promise<void> {
    if (/:tool:/.test(key) && !key.startsWith('xrun:')) {
      this.mirrorAttempts++;
      throw new Error('ECONNRESET: journal write failed');
    }
    return super.put(key, value);
  }
}

const model = (toolCallId: string) =>
  createMockModel(async ({ prompt }: never) =>
    countToolResults(prompt as never) === 0
      ? toolCallResult('charge', toolCallId, { orderId: 'o-1' })
      : finalTextResult('done'));

const chargeTool = (onExec: () => void) => gnlTool({
  description: 'charge',
  inputSchema: z.object({ orderId: z.string() }),
  idempotency: 'args',
  idempotencyWindow: 'cross-run',
  execute: async () => { onExec(); return { charged: 100 }; },
} as never);

afterEach(() => { vi.restoreAllMocks(); });

describe('a failing mirror write', () => {
  it('does not bury a charge that succeeded, and does not let the next attempt charge again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new MirrorHostileJournal();
    let executed = 0;
    const charge = chargeTool(() => { executed++; });

    await runDurable({ runId: 'r1', journal, model: model('call-1'), tools: { charge }, prompt: 'go' } as never);
    expect(journal.mirrorAttempts, 'the mirror was never attempted — this test proves nothing').toBeGreaterThan(0);

    const authoritative = (await journal.listKeys('')).find((k) => k.startsWith('xrun:'))!;
    const record = await journal.get(authoritative) as { status?: string };
    expect(record?.status, 'a failed CONVENIENCE write buried a charge that had already gone through').toBe('succeeded');

    // The retry the operator would run. It must replay, not re-charge.
    await runDurable({ runId: 'r2', journal, model: model('call-2'), tools: { charge }, prompt: 'go' } as never);
    expect(executed, 'the side effect ran a second time').toBe(1);

    expect(warn.mock.calls.flat().join(' '), 'the lost timeline entry was swallowed silently').toMatch(/could not mirror/);
  });

  it('does not fail a pure dedup replay, which has nothing to lose', async () => {
    // A replay executes nothing. Letting a bookkeeping write take the run down with it converts a
    // successful no-op into a run failure.
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new MirrorHostileJournal();
    let executed = 0;
    const charge = chargeTool(() => { executed++; });

    await runDurable({ runId: 'r1', journal, model: model('call-1'), tools: { charge }, prompt: 'go' } as never);
    const second = await runDurable({ runId: 'r2', journal, model: model('call-2'), tools: { charge }, prompt: 'go' } as never);

    expect((second as { text?: string }).text, 'a dedup replay failed because a shadow copy could not be written').toBe('done');
    expect(executed).toBe(1);
  });

  it('leaves the authoritative record alone — the run is correct without its own copy', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new MirrorHostileJournal();
    const charge = chargeTool(() => {});
    await runDurable({ runId: 'r1', journal, model: model('call-1'), tools: { charge }, prompt: 'go' } as never);

    const authoritative = (await journal.listKeys('')).find((k) => k.startsWith('xrun:'))!;
    const record = await journal.get(authoritative) as { status?: string; output?: unknown };
    expect(record?.status).toBe('succeeded');
    expect(record?.output).toEqual({ charged: 100 });
  });

  it('does not turn a withIdempotency dedup HIT into a journal write', async () => {
    // withIdempotency runs outside runDurable, where ctx.runId is a placeholder shared by every call in
    // the process. Mirroring there invented a run: one business key called 1000 times grew the journal
    // to 1001 rows and listRuns reported a single run with 1000 tool calls. The dedup hit is this API's
    // hot path — it wrote nothing before, and must write nothing now.
    const journal = new InMemoryJournal();
    let executed = 0;
    const tools = {
      charge: {
        description: 'charge an order',
        inputSchema: z.object({ orderId: z.string() }),
        execute: async () => { executed++; return { ok: true }; },
      },
    };
    const wrap = () => withIdempotency(tools as never, { journal, window: 'cross-run' });
    const call = (id: string) =>
      (wrap() as unknown as { charge: { execute: (a: unknown, c: unknown) => Promise<unknown> } })
        .charge.execute({ orderId: 'o-1' }, { toolCallId: id });

    for (let i = 0; i < 25; i++) await call(`c${i}`);

    expect(executed, 'the claim did not dedup').toBe(1);
    const keys = await journal.listKeys('');
    expect(keys.filter((k) => k.includes(':tool:')), 'each dedup hit wrote a shadow record').toEqual([]);
  });
});
