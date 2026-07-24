// GOREV (audit E4 — atomic reflect-nudge markers): the reflect NUDGE (duplicate guard + taint guard)
// must be delivered by EXACTLY ONE writer even when two workers race the same (tool,args). The markers
// used to be non-atomic check-then-act (`if (await get(k)===undefined) put(k)` / a plain `put` over a
// prior read), so two concurrent duplicate calls could both read an un-nudged marker and BOTH deliver
// the nudge (double nudge / double incident). The fix routes both markers through `claim()` (CAS via
// putIfAbsent), so the loser of the race escalates instead of delivering a second nudge.
//
// NOTE: the true failure is a multi-worker RACE and is not directly unit-testable in general. These
// tests reproduce the interleave deterministically on InMemoryJournal (two concurrent `execute`s both
// suspend at their first `await get`, then resume with the same pre-nudge marker) — the pre-fix code
// double-nudges here, the fixed code delivers exactly one.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { durableTool } from '../src/durable-tool.js';
import { markRunTainted } from '../src/taint.js';

const isReflect = (o: any) => !!o && typeof o === 'object' && o.__gnl_reflected === true;
const isBlocked = (o: any) => !!o && typeof o === 'object' && '__gnl_limit_exceeded' in o;

describe('reflect-nudge markers are atomic (E4)', () => {
  it("duplicate-guard 'reflect': two concurrent identical duplicates deliver the nudge ONCE (loser blocks)", async () => {
    const journal = new InMemoryJournal();
    const base = { execute: async (a: { amount: number }) => ({ charged: a.amount }) };
    const dt = durableTool(base, { journal, runId: 'r1', limits: { sideEffectDuplicates: 'reflect' } });

    // Seed the duplicate marker: one successful side-effect call.
    await dt.execute!({ amount: 20 }, { toolCallId: 'call-1' });

    // Two concurrent duplicates (same args, fresh toolCallIds) race the one-time nudge.
    const [o2, o3] = await Promise.all([
      dt.execute!({ amount: 20 }, { toolCallId: 'call-2' }),
      dt.execute!({ amount: 20 }, { toolCallId: 'call-3' }),
    ]);

    const reflects = [o2, o3].filter(isReflect).length;
    const blocks = [o2, o3].filter(isBlocked).length;
    expect(reflects).toBe(1); // exactly ONE nudge delivered (pre-fix: 2)
    expect(blocks).toBe(1); // the loser escalates to block — the safe direction
  });

  it("taint-guard 'reflect': two concurrent tainted side effects deliver the nudge ONCE (loser passes as warn)", async () => {
    const journal = new InMemoryJournal();
    const runId = 'r2';
    await markRunTainted(journal, runId, { toolName: 'fetchPage', toolCallId: 'c0' });
    let sends = 0;
    const base = { execute: async () => ({ sent: ++sends }) };
    const dt = durableTool(base, { journal, runId, limits: { taintedSideEffects: 'reflect' } });

    const [o1, o2] = await Promise.all([
      dt.execute!({ iban: 'A' }, { toolCallId: 'call-1' }),
      dt.execute!({ iban: 'A' }, { toolCallId: 'call-2' }),
    ]);

    const reflects = [o1, o2].filter(isReflect).length;
    expect(reflects).toBe(1); // exactly ONE nudge delivered (pre-fix: 2)
    // The loser is NOT nudged — for taint, a post-nudge insistence executes (documented), so it sends.
    expect(sends).toBe(1);
  });
});
