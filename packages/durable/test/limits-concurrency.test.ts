// AUDIT (Finding A): `recordToolOutcome` used to do get→(mutate)→put on a SINGLE '__gnl_limits_state'
// key. Since the AI SDK runs a model step's tools in PARALLEL via `Promise.all`, two concurrent
// `recordToolOutcome` calls would read the SAME stale state and BOTH write the ENTIRE struct back —
// the second `put` SILENTLY clobbered the first's increment (succeededToolCalls was PERMANENTLY
// undercounted → maxToolCalls/loopDetection were silently UNDER-enforced, a limit-BYPASS direction).
//
// FIX: succeededToolCalls is now written via `journal.incrBy` (H8a, engine-internal ATOMIC) — since
// it's commutative, no concurrent increment is lost. This test proves, on InMemoryJournal (which
// supports putIfAbsent/putIfMatch/incrBy), that ALL 10 concurrent `recordToolOutcome('succeeded')`
// calls are counted — through the EXPORTED API only (`recordToolOutcome` + `checkToolGate`), without
// touching the internal key schema (black-box verification).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { checkToolGate, recordToolOutcome } from '../src/limits.js';

describe('AUDIT Finding A — recordToolOutcome does NOT lose updates under concurrency', () => {
  it('10 parallel recordToolOutcome (succeeded) → succeededToolCalls EXACTLY 10 (no lost update)', async () => {
    const journal = new InMemoryJournal();
    const runId = 'concurrent-run';

    // Seed: create the state FIRST with a SEPARATE (NOT succeeded) call — so that all 10 parallel
    // calls below fall into the "state already exists" (steady-state) path; this is the ACTUAL
    // scenario Finding A describes (the first-encounter seeding race is a separate, narrow boundary —
    // see the FIX note at the top of limits.ts).
    await recordToolOutcome(journal, runId, 'seed', 'noop', 'h-seed', 'denied');

    // The RESULT of 10 tool calls (succeeded) is journaled concurrently — the SAME load pattern as
    // the real AI SDK executing parallel tools of the same model step via Promise.all.
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        recordToolOutcome(journal, runId, `call-${i}`, 'noop', `h-${i}`, 'succeeded'),
      ),
    );

    // Verify succeededToolCalls only through the EXPORTED `checkToolGate` (maxToolCalls) API —
    // black-box verification, without touching the internal `__gnl_limits_counters` key.
    const atExactly10 = await checkToolGate(journal, runId, 'noop', 'h-next', { maxToolCalls: 10 });
    expect(atExactly10).toBeDefined(); // if all 10 tools were REALLY counted, it REACHED 10 → the NEXT call must be blocked
    expect(atExactly10?.kind).toBe('maxToolCalls');
    expect(atExactly10?.detail).toMatchObject({ value: 10, limit: 10 });

    const under11 = await checkToolGate(journal, runId, 'noop', 'h-next', { maxToolCalls: 11 });
    expect(under11).toBeUndefined(); // 10 < 11 → should not be blocked yet (if there were a lost update it would be < 10 AND this would also pass — the assertion above is the real proof)
  });

  it('20 concurrent calls mixing succeeded + failed → only succeeded ones are counted, none is lost', async () => {
    const journal = new InMemoryJournal();
    const runId = 'concurrent-run-2';
    await recordToolOutcome(journal, runId, 'seed', 'noop', 'h-seed', 'denied');

    const calls = Array.from({ length: 20 }, (_, i) =>
      recordToolOutcome(journal, runId, `call-${i}`, 'noop', `h-${i}`, i % 2 === 0 ? 'succeeded' : 'failed'),
    );
    await Promise.all(calls);

    // 10 succeeded (even indices) → maxToolCalls=10 should be reached EXACTLY.
    const gate = await checkToolGate(journal, runId, 'noop', 'h-next', { maxToolCalls: 10 });
    expect(gate).toBeDefined();
    expect(gate?.detail).toMatchObject({ value: 10, limit: 10 });
  });
});
