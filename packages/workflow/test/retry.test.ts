// retry combinator — declarative "try N times → fallback" (common workflow retry-config semantics).
// What's tested: success after a transient error, fallback / RetryExhaustedError on exhaustion, the
// attempt counter surviving crash-resume, suspension not consuming an attempt, backoff invocation, replay.
import { describe, it, expect } from 'vitest';
import { workflow, step, retry, RetryExhaustedError, sleep as wfSleep } from '../src/index.js';

/** Test journal (JournalLike): Map-based. */
function mkJournal() {
  const m = new Map<string, unknown>();
  return {
    map: m,
    async get<T>(k: string) { return m.get(k) as T | undefined; },
    async put(k: string, v: unknown) { m.set(k, v); },
  };
}

const flaky = (failTimes: number, counter: { runs: number }) =>
  step('is', async (n: number) => {
    counter.runs++;
    if (counter.runs <= failTimes) throw new Error(`transient error #${counter.runs}`);
    return n * 2;
  });

describe('retry', () => {
  it('transient error: succeeds on the 2nd attempt; the output is journaled, does not run again on replay', async () => {
    const journal = mkJournal();
    const c = { runs: 0 };
    const wf = workflow<number>().then(retry(flaky(1, c), { attempts: 3 }));
    expect(await wf.run(5, { runId: 'r1', journal })).toBe(10);
    expect(c.runs).toBe(2);
    expect(journal.map.get('r1:wf:is:attempts')).toBe(1); // 1 failed attempt recorded

    expect(await wf.run(5, { runId: 'r1', journal })).toBe(10); // replay
    expect(c.runs).toBe(2); // the step did NOT run again
  });

  it('fallback runs once exhausted (journaled under its own key) and its output becomes the step output', async () => {
    const journal = mkJournal();
    const c = { runs: 0 };
    const fb = { runs: 0 };
    const wf = workflow<number>().then(
      retry(flaky(99, c), {
        attempts: 2,
        fallback: step('backup', async (n: number) => { fb.runs++; return -n; }),
      }),
    );
    expect(await wf.run(7, { runId: 'r2', journal })).toBe(-7);
    expect(c.runs).toBe(2); // tried exactly `attempts` times
    expect(fb.runs).toBe(1);
    expect(journal.map.get('r2:wf:backup')).toBe(-7); // fallback journaled separately

    expect(await wf.run(7, { runId: 'r2', journal })).toBe(-7); // replay: neither runs again
    expect(c.runs).toBe(2);
    expect(fb.runs).toBe(1);
  });

  // The fallback's output is stored under the RETRIED step's id, so the record alone could not say
  // Which of the two produced it: a "charged via provider A" step read identically whether it worked
  // First time or failed twice and landed on provider B. `:attempts` sitting next to it does not
  // Close that — on a backend with `incrBy` the counter lives in a counter map rather than the
  // Field, so a reader that only calls `get` sees nothing.
  it('records that the output came from the fallback, readable with a plain get', async () => {
    const journal = mkJournal();
    const c = { runs: 0 };
    const wf = workflow<number>().then(
      retry(flaky(99, c), { attempts: 2, fallback: step('backup', async (n: number) => -n) }),
    );
    await wf.run(7, { runId: 'r3', journal });

    expect(journal.map.get('r3:wf:is')).toBe(-7);
    expect(journal.map.get('r3:wf:is:_fallback')).toEqual({ __gnlFallback: true, attempts: 2, stepId: 'backup' });
  });

  it('a step that succeeded on its own carries no fallback marker — including after a retry', async () => {
    const journal = mkJournal();
    const c = { runs: 0 };
    // Fails once, then succeeds: retried, but the output is the step's own.
    const wf = workflow<number>().then(
      retry(flaky(1, c), { attempts: 3, fallback: step('backup', async (n: number) => -n) }),
    );
    expect(await wf.run(5, { runId: 'r4', journal })).toBe(10);
    expect(journal.map.get('r4:wf:is:_fallback'), 'a retry is not a substitution').toBeUndefined();
  });

  it('without a fallback, throws RetryExhaustedError (stepId + attempts + cause)', async () => {
    const journal = mkJournal();
    const c = { runs: 0 };
    const wf = workflow<number>().then(retry(flaky(99, c), { attempts: 3 }));
    const err = await wf.run(1, { runId: 'r3', journal }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect(err.stepId).toBe('is');
    expect(err.attempts).toBe(3);
    expect(String(err.cause)).toContain('transient error #3');
    expect(c.runs).toBe(3);
  });

  it('crash-resume: consumed attempts are counted from the journal — total N is never exceeded', async () => {
    const journal = mkJournal();
    const c = { runs: 0 };
    const wf = workflow<number>().then(retry(flaky(99, c), { attempts: 3 }));
    // First "process": exhausts 3 attempts and dies (error swallowed = crash simulation).
    await wf.run(1, { runId: 'r4', journal }).catch(() => {});
    expect(c.runs).toBe(3);
    // Resume ("new process"): counter is 3 → treated as exhausted without attempting again.
    const err = await wf.run(1, { runId: 'r4', journal }).catch((e) => e);
    expect(err).toBeInstanceOf(RetryExhaustedError);
    expect(c.runs).toBe(3); // did NOT retry N more times

    // With a fallback variant, resume goes straight to the fallback.
    const journal2 = mkJournal();
    const c2 = { runs: 0 };
    const mk = (withFb: boolean) => workflow<number>().then(
      retry(flaky(99, c2), { attempts: 2, ...(withFb ? { fallback: step('backup', async () => 0) } : {}) }),
    );
    await mk(false).run(1, { runId: 'r5', journal: journal2 }).catch(() => {});
    expect(await mk(true).run(1, { runId: 'r5', journal: journal2 })).toBe(0);
    expect(c2.runs).toBe(2); // the step was not retried on resume
  });

  it('suspension (sleep) does NOT consume an attempt: the suspend propagates as-is, the counter does not increase', async () => {
    const journal = mkJournal();
    const wf = workflow<number>().then(retry(wfSleep('wait', Date.now() + 60_000) as any, { attempts: 2 }));
    const res = await wf.runResumable(1, { runId: 'r6', journal });
    expect(res.status).toBe('suspended');
    expect(journal.map.get('r6:wf:wait:attempts')).toBeUndefined(); // counter was NEVER written
  });

  it('backoff: the function is called with the attempt index after each failed attempt (except the last)', async () => {
    const journal = mkJournal();
    const c = { runs: 0 };
    const seen: number[] = [];
    const wf = workflow<number>().then(
      retry(flaky(99, c), { attempts: 3, backoffMs: (a) => { seen.push(a); return 0; } }),
    );
    await wf.run(1, { runId: 'r7', journal }).catch(() => {});
    expect(seen).toEqual([1, 2]); // not expected after the 3rd attempt (exhaustion)
  });

  it('attempts < 1 → early and clear error', () => {
    expect(() => retry(step('x', async () => 1), { attempts: 0 })).toThrow(/attempts >= 1/);
  });
});
