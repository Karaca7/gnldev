// The shape a refusal has to have before it teaches anything.
//
// Borrowed from rustc, whose diagnostics are three parts and never two: the ERROR says what already
// happened, in the past tense; a NOTE says why it matters and what it costs; a HELP gives a line you
// can copy. Our refusals had the first part and stopped — "run 'x' is locked by another process" is
// true, is not actionable, and leaves the reader to guess whether they broke something.
//
// Pinned by STRUCTURE here (the three markers, and help carrying something copyable) and by content in
// the suites next to each message. A future rewording is fine; dropping a limb is what must fail.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { acquireRunLock } from '../src/run-lock.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

/** The three limbs, as a reader meets them: an opening line, then `note:`, then `help:`. */
function limbsOf(message: string): { error: string; note?: string; help?: string } {
  const noteAt = message.indexOf('\n  note:');
  const helpAt = message.indexOf('\n  help:');
  return {
    error: (noteAt >= 0 ? message.slice(0, noteAt) : message).trim(),
    ...(noteAt >= 0 ? { note: message.slice(noteAt, helpAt >= 0 ? helpAt : undefined).trim() } : {}),
    ...(helpAt >= 0 ? { help: message.slice(helpAt).trim() } : {}),
  };
}

describe('run_busy', () => {
  async function busyMessage(): Promise<string> {
    const journal = new InMemoryJournal();
    // Somebody else holds it. Exactly the production shape: a second worker picked up the same runId.
    const held = await acquireRunLock(journal, 'busy-1', 'worker-a', 60_000);
    expect(held, 'the fixture must actually hold the lock, or this asserts nothing').toBeTruthy();
    try {
      await runDurable({
        runId: 'busy-1', journal, model: createMockModel(async () => finalTextResult('ok')),
        prompt: 'hi', lock: { owner: 'worker-b', ttlMs: 60_000 },
      });
      throw new Error('expected a RunBusyError');
    } catch (e) {
      return (e as Error).message;
    }
  }

  it('carries all three limbs', async () => {
    const l = limbsOf(await busyMessage());
    expect(l.error).toContain("busy-1");
    expect(l.note, 'a lock refusal with no note is the message we already had').toBeDefined();
    expect(l.help, 'nothing to copy means nothing to do').toBeDefined();
  });

  it("the note says the second run did NOT start, and that this can be the correct outcome", async () => {
    // The single most expensive ambiguity in this message. A 409 reads as "something went wrong", and
    // the honest reading is usually "the protection worked" — one run is doing the work, and a
    // duplicate was declined. A caller who cannot tell those apart writes a retry loop around a lock.
    const l = limbsOf(await busyMessage());
    expect(l.note).toMatch(/not started|NOT started|did not start/);
    expect(l.note).toMatch(/what you want|intended|normal/i);
  });

  it('the help offers both a way to WATCH the live run and a way to start a different one', async () => {
    const l = limbsOf(await busyMessage());
    expect(l.help).toContain('X-Gnl-Run-Id');
    expect(l.help).toMatch(/different runId|another runId|separate runId/i);
  });

  // PAKET #6. The advice used to be "use a different runId", and for most callers that names a field
  // they never filled in: they sent a workKey and the engine derived `run1_<digest>` from it. Both
  // sentences have to be here — the raw surface still exists and its callers really do hold the id.
  it('the help names the axis the caller actually holds (workKey), and still speaks to the raw surface', async () => {
    const l = limbsOf(await busyMessage());
    expect(l.help).toContain('workKey');
    expect(l.help, 'a raw runDurable caller has no workKey to change').toMatch(/different runId/i);
  });
});
