// CAS'd runStep (audit finding: workflow had no CAS) — what's tested:
// 1) with a putIfAbsent journal, TWO concurrent runSteps run the same step ONCE only,
//    the loser returns the winner's result (multi-worker exactly-once).
// 2) with a journal lacking putIfAbsent, the old get+put behavior is preserved unchanged (single-process safe).
// 3) old-format (plain value, no `{ v }` wrapper) records can be replayed — backward compatibility.
// 4) retry counter: with a journal supporting incrBy/getCounters, uses the atomic counter;
//    an old plain-value counter record is also read (the larger of the two sources).
import { describe, it, expect } from 'vitest';
import { workflow, step, retry, RetryExhaustedError, type JournalLike } from '../src/index.js';

/** Old-style journal without putIfAbsent (like the existing tests). */
function plainJournal() {
  const m = new Map<string, unknown>();
  const j: JournalLike & { map: Map<string, unknown> } = {
    map: m,
    async get<T>(k: string) {
      return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined;
    },
    async put(k: string, v: unknown) {
      m.set(k, structuredClone(v));
    },
  };
  return j;
}

/** CAS journal with putIfAbsent. */
function casJournal() {
  const m = new Map<string, unknown>();
  let putIfAbsentCalls = 0;
  const j: JournalLike & { map: Map<string, unknown>; putIfAbsentCalls(): number } = {
    map: m,
    putIfAbsentCalls: () => putIfAbsentCalls,
    async get<T>(k: string) {
      return m.has(k) ? (structuredClone(m.get(k)) as T) : undefined;
    },
    async put(k: string, v: unknown) {
      m.set(k, structuredClone(v));
    },
    // no await between has→set → structurally atomic in single-thread JS (same as InMemoryJournal).
    async putIfAbsent(k: string, v: unknown) {
      putIfAbsentCalls++;
      if (m.has(k)) return false;
      m.set(k, structuredClone(v));
      return true;
    },
  };
  return j;
}

/** Journal also supporting incrBy/getCounters (for the retry counter's atomic path). */
function counterJournal() {
  const j = casJournal();
  const counters = new Map<string, Record<string, number>>();
  const cj = j as typeof j & {
    incrBy(key: string, fields: Record<string, number>): Promise<void>;
    getCounters(key: string): Promise<Record<string, number> | undefined>;
    counters: Map<string, Record<string, number>>;
  };
  cj.counters = counters;
  cj.incrBy = async (key, fields) => {
    const cur = counters.get(key) ?? {};
    for (const [f, d] of Object.entries(fields)) cur[f] = (cur[f] ?? 0) + d;
    counters.set(key, cur);
  };
  cj.getCounters = async (key) => {
    const c = counters.get(key);
    return c ? { ...c } : undefined;
  };
  return cj;
}

describe('@gnl/workflow — CAS (multi-worker exactly-once)', () => {
  it('journal with putIfAbsent: two concurrent runs execute the same step ONCE; the loser returns the winner\'s result', async () => {
    // Both runs start their get BEFORE computing (microtask ordering) →
    // both see a cache-miss, both compute → CAS picks a single writer.
    const journal = casJournal();
    let runs = 0;
    const s = step<number, { seq: number }>('is', async () => {
      runs++;
      return { seq: runs }; // each run produces a DIFFERENT result → the loser's return value is distinguishable
    });
    const wf = workflow<number>().then(s);

    const [a, b] = await Promise.all([
      wf.run(1, { runId: 'cas1', journal }),
      wf.run(1, { runId: 'cas1', journal }),
    ]);

    // Both sides may have computed (race window) but only ONE result is written to the journal
    // and BOTH sides return that result (the loser discards its own, reads the winner's).
    expect(runs).toBe(2); // the window really opened (compute ran twice — test precondition)
    expect(a).toEqual(b); // single source of truth: both return the winner's record
    expect(journal.map.get('cas1:wf:is')).toEqual(a); // journal record = returned value
    // Replay: while a record exists, compute never runs.
    expect(await wf.run(1, { runId: 'cas1', journal })).toEqual(a);
    expect(runs).toBe(2);
  });

  it('journal with putIfAbsent: if a record already exists, compute never runs, putIfAbsent is not called', async () => {
    const journal = casJournal();
    let runs = 0;
    const wf = workflow<number>().then(step('is', async (n: number) => { runs++; return n * 2; }));
    expect(await wf.run(5, { runId: 'cas2', journal })).toBe(10);
    expect(journal.putIfAbsentCalls()).toBe(1);
    expect(await wf.run(5, { runId: 'cas2', journal })).toBe(10); // replay
    expect(runs).toBe(1);
    expect(journal.putIfAbsentCalls()).toBe(1); // cache-hit path never reaches CAS
  });

  it('journal without putIfAbsent: old get+put behavior is preserved (fallback)', async () => {
    const journal = plainJournal();
    let runs = 0;
    const wf = workflow<number>().then(step('is', async (n: number) => { runs++; return n + 1; }));
    expect(await wf.run(1, { runId: 'old1', journal })).toBe(2);
    expect(journal.map.get('old1:wf:is')).toBe(2); // written as a plain value
    expect(await wf.run(1, { runId: 'old1', journal })).toBe(2); // replay
    expect(runs).toBe(1); // exactly-once (single process)
  });

  it('backward compatibility: old-format (plain value, no `{v}` wrapper) record is replayed — compute never runs', async () => {
    const journal = casJournal();
    // Simulates a plain-value record left over from an old run (pre-CAS format).
    journal.map.set('legacy1:wf:is', 42);
    let runs = 0;
    const wf = workflow<number>().then(step('is', async () => { runs++; return -1; }));
    expect(await wf.run(0, { runId: 'legacy1', journal })).toBe(42); // old record read
    expect(runs).toBe(0); // step never ran
  });

  it('retry counter: a journal with incrBy uses the atomic counter (consumed attempts are counted on crash-resume)', async () => {
    const journal = counterJournal();
    let runs = 0;
    const failing = step('is', async () => { runs++; throw new Error(`error #${runs}`); });
    const wf = workflow<number>().then(retry(failing, { attempts: 3 }));

    // First "process": exhausts 3 attempts and dies (error swallowed = crash simulation).
    await wf.run(1, { runId: 'rc1', journal }).catch(() => {});
    expect(runs).toBe(3);
    expect(journal.counters.get('rc1:wf:is:attempts')).toEqual({ n: 3 }); // in the atomic counter
    expect(journal.map.has('rc1:wf:is:attempts')).toBe(false); // the plain put path was NEVER written to

    // Resume: the counter is read from the journal (getCounters) → does NOT retry.
    await wf.run(1, { runId: 'rc1', journal }).catch(() => {});
    expect(runs).toBe(3);
  });

  it('retry counter backward compatibility: an old plain-value counter record is also read on a journal with incrBy', async () => {
    const journal = counterJournal();
    // Plain-value counter left over from an old run (had been written via put).
    journal.map.set('rc2:wf:is:attempts', 2);
    let runs = 0;
    const failing = step('is', async () => { runs++; throw new Error('error'); });
    const wf = workflow<number>().then(retry(failing, { attempts: 3 }));
    await wf.run(1, { runId: 'rc2', journal }).catch(() => {});
    expect(runs).toBe(1); // 2 attempts counted from the old record → only 1 attempt remains
  });

  it('regression: mixed legacy + incrBy mode — repeated resumes do NOT add extra attempts (bug: each resume added +1 real run)', async () => {
    const journal = counterJournal();
    // Plain-value counter left over from a run predating incrBy: 2 attempts already consumed.
    journal.map.set('rc3:wf:is:attempts', 2);
    let runs = 0;
    const failing = step('is', async () => { runs++; throw new Error(`error #${runs}`); });
    const wf = workflow<number>().then(retry(failing, { attempts: 3 }));

    // "Resume 1": legacy=2 + policy.attempts=3 → only 1 attempt should remain, then exhaust.
    const err1 = await wf.run(1, { runId: 'rc3', journal }).catch((e) => e);
    expect(err1).toBeInstanceOf(RetryExhaustedError);
    expect(runs).toBe(1); // exactly ONE additional real run

    // "Resume 2" and "Resume 3": the counter should already appear exhausted — the step must NOT run again.
    const err2 = await wf.run(1, { runId: 'rc3', journal }).catch((e) => e);
    const err3 = await wf.run(1, { runId: 'rc3', journal }).catch((e) => e);
    expect(err2).toBeInstanceOf(RetryExhaustedError);
    expect(err3).toBeInstanceOf(RetryExhaustedError);
    expect(runs).toBe(1); // total still 1 after 3 resumes (would have been 3 with the bug)
    expect(journal.map.has('rc3:wf:is:attempts')).toBe(true); // the legacy field already EXISTED (2) — untouched but not removed either
    expect(journal.map.get('rc3:wf:is:attempts')).toBe(2); // the legacy value stays frozen (new design: only the counter is seeded)
  });
});
