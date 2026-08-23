// A SOURCE guard, not a behaviour test, and deliberately so.
//
// `PostgresStorage` holds two ways to run a statement. `this.q` goes through the POOL — any free
// connection. `this.tx(async (q) => …)` checks out ONE client, issues BEGIN on it, and hands that
// client's query function in as `q`. The two are interchangeable to the type checker and to every
// test in this suite, and they are not interchangeable at all: a statement issued through `this.q`
// inside a `tx` body runs on a DIFFERENT connection, outside the transaction. It is not rolled back
// when the transaction aborts, and it does not see or respect the transaction's row locks.
//
// That is not hypothetical. A mechanical `q(` → `this.q(` rename (commit bd393b29) converted twelve
// call sites, and the result was measured against real Postgres:
//   • `applyBatch` stopped being atomic — a batch that failed mid-way left its CLAIM row committed,
//     which is the one row exactly-once depends on. The work it claimed can then never run again.
//   • `put`'s `lockRunRow` serialisation went dead — the lock was taken on a pool connection and
//     released immediately, so two writers to the same run both read "no previous row" and both
//     applied +1. `toolCalls` came back 2 for a single key.
//
// The behavioural proof lives in integration-real.test.ts (T1 and D4-real), and it is SKIPPED unless
// GNL_INTEGRATION=1, which is why the defect survived a full green suite. The default suite runs
// Postgres on pg-mem, which — as postgres-storage.ts:186 says in its own comment — accepts
// BEGIN/COMMIT/ROLLBACK but does not actually UNDO on rollback, and does not enforce row locking.
// pg-mem is STRUCTURALLY incapable of catching this class of bug. So this test does not try to
// reproduce the behaviour; it reads the source and asserts the mistake is not present.
//
// Two shapes are checked, because the rename hit both:
//   1. `this.q(` appearing inside a `this.tx(async (q) => { … })` body.
//   2. a helper that ACCEPTS `q: Q` — meaning its caller is handing it a transaction — and then
//      ignores the parameter to call `this.q` anyway. `lockRunRow`, `touchRunDelta` and `recountRun`
//      all did this, and the first of the three is what made the row lock a no-op.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/postgres-storage.ts', import.meta.url));
const source = readFileSync(SRC, 'utf8');

/** The `{ … }` block opened by `marker`, matched by brace depth. */
function blockAfter(text: string, from: number, marker: string): { body: string; end: number } | null {
  const start = text.indexOf(marker, from);
  if (start === -1) return null;
  let i = start + marker.length - 1; // the '{' the marker ends on
  let depth = 0;
  for (; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}' && --depth === 0) break;
  }
  return { body: text.slice(start, i + 1), end: i + 1 };
}

/** The line number a source offset falls on, so a failure names a place rather than a pattern. */
const lineOf = (offset: number) => source.slice(0, offset).split('\n').length;

describe('PostgresStorage: a transaction body must not reach for the pool', () => {
  it('no `this.q(` inside a `this.tx(async (q) => …)` body — those statements would escape the transaction', () => {
    const MARKER = 'this.tx(async (q) => {';
    const offenders: string[] = [];
    let at = 0;
    let blocks = 0;
    for (;;) {
      const found = blockAfter(source, at, MARKER);
      if (!found) break;
      blocks++;
      const base = source.indexOf(MARKER, at);
      let k = found.body.indexOf('this.q(');
      while (k !== -1) {
        offenders.push(`line ${lineOf(base + k)}`);
        k = found.body.indexOf('this.q(', k + 1);
      }
      at = found.end;
    }
    // The guard is worthless if it scans nothing — a renamed helper would silently make this vacuous.
    expect(blocks, 'no `this.tx(async (q) => {` blocks found — this guard is scanning nothing, so fix the marker')
      .toBeGreaterThan(0);
    expect(offenders,
      'a statement inside a transaction body is going through the POOL (`this.q`) instead of the '
      + 'transaction client (`q`). It runs on another connection: not rolled back on abort, and blind '
      + 'to the transaction\'s row locks. Use the `q` the callback is handed.')
      .toEqual([]);
  });

  it('no helper that takes `q: Q` calls `this.q(` instead — an ignored transaction client is the same bug', () => {
    const sigs = [...source.matchAll(/^\s*(?:private\s+)?async\s+(\w+)\s*\(q: Q[,)]/gm)];
    const offenders: string[] = [];
    for (const m of sigs) {
      const start = m.index!;
      let depth = 0;
      let i = source.indexOf('{', start);
      const open = i;
      for (; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) break;
      }
      const body = source.slice(open, i + 1);
      let k = body.indexOf('this.q(');
      while (k !== -1) {
        offenders.push(`${m[1]}() at line ${lineOf(open + k)}`);
        k = body.indexOf('this.q(', k + 1);
      }
    }
    expect(sigs.length, 'no `(q: Q` helpers found — this guard is scanning nothing').toBeGreaterThan(0);
    expect(offenders,
      'this helper is HANDED a transaction client and ignores it, going through the pool instead. '
      + '`lockRunRow` did exactly this, which is what turned the run-row lock into a no-op.')
      .toEqual([]);
  });
});
