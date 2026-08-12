// the core-hardening review: journal-based append-log (durable-log) + BasicMemory thread sweeping.
// Continuation of sweepRuns' safety philosophy: a record/thread whose age cannot be measured is NOT DELETED, and is counted in the report.
import { describe, it, expect, vi } from 'vitest';
import {
  InMemoryJournal, BasicMemory, appendLog, listLog, consumeOnce, sweepLog, sweepThreads,
  createRetentionSweeper, runKeys,
} from '../src/index.js';

const HOUR = 60 * 60 * 1000;

describe('sweepLog (durable-log retention)', () => {
  it('deletes only records older than the threshold; listLog returns the remainder correctly; record without ts is kept', async () => {
    const journal = new InMemoryJournal();
    const now = Date.now();

    // Fresh record: via the real API (appendLog stamps `at: Date.now()`).
    const freshId = await appendLog(journal, 'evtlog', { msg: 'fresh' });
    // Stale records: write directly to the journal in durable-log format, to control ts
    // (same schema as what appendLog writes: `${ns}:${id}` → { id, payload, at }).
    await journal.put('evtlog:old-1', { id: 'old-1', payload: { msg: 'stale 1' }, at: now - 3 * HOUR });
    await journal.put('evtlog:old-2', { id: 'old-2', payload: { msg: 'stale 2' }, at: now - 2 * HOUR });
    // record without ts (no at field): age cannot be measured → must be kept.
    await journal.put('evtlog:no-ts', { id: 'no-ts', payload: { msg: 'unstamped' } });
    // NEIGHBORING namespace: sweeping 'evtlog' must NOT TOUCH 'evtlog2' (prefix boundary).
    await journal.put('evtlog2:old-x', { id: 'old-x', payload: 1, at: now - 3 * HOUR });

    const res = await sweepLog(journal, 'evtlog', { olderThanMs: HOUR, now });
    expect(res.scanned).toBe(4); // fresh + old-1 + old-2 + no-ts (neighboring ns not scanned)
    expect(res.deleted).toBe(2);
    expect(res.keptNoTs).toBe(1);

    const remaining = await listLog(journal, 'evtlog');
    expect(remaining.map((i) => i.id).sort()).toEqual([freshId, 'no-ts'].sort());
    // Neighboring namespace intact.
    expect(await journal.get('evtlog2:old-x')).toBeDefined();
  });

  it('when markerFor is given, clears consume markers only for DELETED records', async () => {
    const journal = new InMemoryJournal();
    const now = Date.now();
    await journal.put('q:old', { id: 'old', payload: 'a', at: now - 3 * HOUR });
    await journal.put('q:fresh', { id: 'fresh', payload: 'b', at: now });
    // the consumeOnce marker schema belongs to the CALLER (no fixed schema at journal-level) —
    // here the test uses its own schema (`ack:w1:<id>`) and reports it to sweepLog via markerFor.
    expect(await consumeOnce(journal, 'ack:w1:old')).toBe(true);
    expect(await consumeOnce(journal, 'ack:w1:fresh')).toBe(true);

    const res = await sweepLog(journal, 'q', {
      olderThanMs: HOUR, now,
      markerFor: (it) => `ack:w1:${it.id}`,
    });
    expect(res.deleted).toBe(1);
    expect(res.deletedMarkers).toBe(1);
    expect(await journal.get('ack:w1:old')).toBeUndefined(); // the deleted one's marker is gone
    expect(await journal.get('ack:w1:fresh')).toBeDefined(); // the remaining one's marker still stands
  });

  it("prefix-neighboring: an old key is not deleted if it is a prefix of a key that WILL REMAIN (deletePrefix safety)", async () => {
    const journal = new InMemoryJournal();
    const now = Date.now();
    // key 'a' is a prefix of 'a:ext' — deletePrefix('ns:a') would also sweep away the fresh 'ns:a:ext' → must be skipped.
    await journal.put('ns:a', { id: 'a', payload: 1, at: now - 3 * HOUR });
    await journal.put('ns:a:ext', { id: 'a:ext', payload: 2, at: now });

    const res = await sweepLog(journal, 'ns', { olderThanMs: HOUR, now });
    expect(res.deleted).toBe(0);
    expect(await journal.get('ns:a')).toBeDefined();
    expect(await journal.get('ns:a:ext')).toBeDefined();
  });

  it('clear error when listKeys/deletePrefix is unsupported (requireDelete pattern)', async () => {
    const noDelete = { async get() { return undefined; }, async put() {}, async listKeys() { return []; } } as any;
    await expect(sweepLog(noDelete, 'x', { olderThanMs: 1 })).rejects.toThrow(/deletePrefix/);
    const noList = { async get() { return undefined; }, async put() {}, async deletePrefix() { return 0; } } as any;
    await expect(sweepLog(noList, 'x', { olderThanMs: 1 })).rejects.toThrow(/listKeys/);
    await expect(sweepThreads(noList, { olderThanMs: 1 })).rejects.toThrow(/listKeys/);
  });
});

describe('sweepThreads (BasicMemory retention)', () => {
  it('purges only the old thread based on its last message ts; the new one remains readable', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const now = Date.now();

    // Message ts's: BasicMemory itself does not stamp them — the `ts` field added by the caller is read.
    await memory.append('old-thread', [
      { role: 'user', content: 'hello', ts: now - 5 * HOUR },
      { role: 'assistant', content: 'hi', ts: now - 4 * HOUR },
    ]);
    await memory.setWorkingMemory('old-thread', 'note to be forgotten');
    await memory.append('new-thread', [{ role: 'user', content: 'fresh', ts: now - 1000 }]);
    await memory.setWorkingMemory('new-thread', 'note to keep');

    const res = await sweepThreads(journal, { olderThanMs: HOUR, now });
    expect(res.scanned).toBe(2);
    expect(res.purged).toEqual(['old-thread']);
    expect(res.keptNoTs).toBe(0);

    // ALL trace of the old thread is gone (messages + working, purgeThread prefix delete).
    expect(await memory.getMessages('old-thread')).toEqual([]);
    expect(await memory.getWorkingMemory('old-thread')).toBeUndefined();
    // New thread remains readable.
    expect(await memory.getMessages('new-thread')).toHaveLength(1);
    expect(await memory.getWorkingMemory('new-thread')).toBe('note to keep');
  });

  it('thread with a message lacking ts is kept and counted in keptNoTs (safe side)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const now = Date.now();

    await memory.append('unstamped', [{ role: 'user', content: 'no ts' }]); // raw AI SDK message
    await memory.append('old', [{ role: 'user', content: 'x', ts: now - 3 * HOUR }]);

    const res = await sweepThreads(journal, { olderThanMs: HOUR, now });
    expect(res.purged).toEqual(['old']);
    expect(res.keptNoTs).toBe(1);
    expect(await memory.getMessages('unstamped')).toHaveLength(1); // not deleted
  });

  it("suffix-based inference still works correctly even if threadId contains ':'", async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const now = Date.now();

    // threadId = 'user:42:chat' → key 'mem:user:42:chat:messages' (naive split inferred it incorrectly).
    await memory.append('user:42:chat', [{ role: 'user', content: 'x', ts: now - 3 * HOUR }]);

    const res = await sweepThreads(journal, { olderThanMs: HOUR, now });
    expect(res.purged).toEqual(['user:42:chat']);
    expect(await memory.getMessages('user:42:chat')).toEqual([]);
  });

  it('ISO-string and Date-based ts fields (createdAt) are also recognized', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const now = Date.now();

    await memory.append('iso-old', [{ role: 'user', content: 'x', createdAt: new Date(now - 3 * HOUR).toISOString() }]);
    await memory.append('date-new', [{ role: 'user', content: 'y', createdAt: new Date(now) }]);

    const res = await sweepThreads(journal, { olderThanMs: HOUR, now });
    expect(res.purged).toEqual(['iso-old']);
    expect(await memory.getMessages('date-new')).toHaveLength(1);
  });
});

// Phase 8.3: opt-in automatic retention scheduling — periodic sweeping USING createPollLoop.
// Does NOT automatically START anything; no round runs until the user calls start().
describe('createRetentionSweeper (Phase 8.3 — opt-in automatic retention)', () => {
  it('runOnce(): sweepRuns + (if given) sweepLog run together in a single round; fresh data is kept', async () => {
    // Virtual time: age here is measured against real Date.now() timestamps stamped at write time,
    // so a real-clock gap between writing "stale" and "fresh" records made the THRESHOLD itself the
    // thing under load — a stalled event loop between the two writes could age the "fresh" record
    // past the cutoff too. Fake timers make Date.now() advance by exactly the requested gap.
    vi.useFakeTimers();
    try {
      const journal = new InMemoryJournal();
      await journal.put(runKeys.model('old-run', 0), { content: [] });
      await appendLog(journal, 'auditlog', { msg: 'stale audit record' }); // 'at' = the Date.now() at write time
      await vi.advanceTimersByTimeAsync(20); // real time gap — the above can now be considered 'stale'

      // Fresh records: right before the runOnce call (age should stay under the threshold).
      await journal.put(runKeys.model('fresh-run', 0), { content: [] });
      await appendLog(journal, 'auditlog', { msg: 'fresh audit record' });

      const sweeper = createRetentionSweeper(journal, {
        sweep: { olderThanMs: 5 },
        logSweep: { ns: 'auditlog', olderThanMs: 5 },
      });
      const summary = await sweeper.runOnce();

      expect(summary.purgedRuns).toBe(1);
      expect(summary.deletedLog).toBe(1);

      const runs = await journal.listRuns();
      const ids = (Array.isArray(runs) ? runs : (runs as any).items).map((r: any) => r.runId);
      expect(ids).not.toContain('old-run');
      expect(ids).toContain('fresh-run'); // fresh run kept

      const remainingLog = await listLog(journal, 'auditlog');
      expect(remainingLog.map((i) => i.payload)).toEqual([{ msg: 'fresh audit record' }]); // only the fresh one remains
    } finally {
      vi.useRealTimers();
    }
  });

  it('no sweep round runs AUTOMATICALLY without calling start()', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.model('old-run', 0), { content: [] });
    await new Promise((r) => setTimeout(r, 20));

    createRetentionSweeper(journal, { intervalMs: 5, sweep: { olderThanMs: 5 } }); // start() NOT CALLED
    await new Promise((r) => setTimeout(r, 60));

    const runs = await journal.listRuns();
    const ids = (Array.isArray(runs) ? runs : (runs as any).items).map((r: any) => r.runId);
    expect(ids).toContain('old-run'); // no automatic trigger at all — still there
  });

  it('start(): runs automatic rounds at intervalMs intervals (proof of createPollLoop usage); stop() halts it', async () => {
    // Virtual time: whether a round ran within the window is a tick-count question (at least one of
    // several 15ms ticks in an 80ms window), unmeasurable on a loaded machine.
    vi.useFakeTimers();
    try {
      const journal = new InMemoryJournal();
      await journal.put(runKeys.model('old-run', 0), { content: [] });
      await vi.advanceTimersByTimeAsync(20);

      const sweeper = createRetentionSweeper(journal, { intervalMs: 15, sweep: { olderThanMs: 5 } });
      sweeper.start();
      await vi.advanceTimersByTimeAsync(80); // let a few rounds pass
      sweeper.stop();

      const runs = await journal.listRuns();
      const ids = (Array.isArray(runs) ? runs : (runs as any).items).map((r: any) => r.runId);
      expect(ids).not.toContain('old-run'); // one of the automatic rounds swept it
    } finally {
      vi.useRealTimers();
    }
  });

  it('onError is called if sweepRuns errors in a round; runOnce does not throw (the chain doesn\'t die)', async () => {
    const broken = {
      async get() { return undefined; },
      async put() {},
      async deletePrefix() { return 0; },
      // listRuns/readRun INTENTIONALLY missing → sweepRuns throws internally.
    } as any;
    const errors: unknown[] = [];
    const sweeper = createRetentionSweeper(broken, {
      sweep: { olderThanMs: 1000 },
      onError: (e) => errors.push(e),
    });

    const summary = await sweeper.runOnce();
    expect(summary.purgedRuns).toBe(0);
    expect(summary.deletedLog).toBe(0);
    expect(errors.length).toBe(1);
  });
});

// GDPR runbook helper (purgeOrganization) — the org:<id>: boundary sweep incl. counters (the P1.6
// deletePrefix fix is what makes this complete) + prefix-boundary safety.
import { purgeOrganization } from '../src/retention.js';

describe('purgeOrganization (GDPR runbook)', () => {
  it('sweeps the org exactly: journal keys + incrBy counters + org wfrun records; neighbor org and root audit intact', async () => {
    const journal = new InMemoryJournal();
    await journal.put('org:acme:r1:model:0', { content: [] });
    await journal.incrBy!('org:acme:__usage__', { runs: 3, costUsd: 1.5 }); // GDPR: usage counters must go too
    await journal.put('org:acme:wfrun:w1', { runId: 'w1', status: 'suspended', updatedAt: 1 });
    await journal.put('org:acme2:r9:model:0', { content: [] }); // prefix-SHARING neighbor ('acme' vs 'acme2')
    await appendLog(journal, '__audit__', { actor: 'op', action: 'x', target: 'y', org: 'acme' }); // root trail

    const deleted = await purgeOrganization(journal, 'acme');
    expect(deleted).toBeGreaterThanOrEqual(2);
    expect(await journal.get('org:acme:r1:model:0')).toBeUndefined();
    expect(await journal.getCounters!('org:acme:__usage__')).toBeUndefined(); // counter swept
    expect(await journal.get('org:acme:wfrun:w1')).toBeUndefined(); // workflow registry record swept
    expect(await journal.get('org:acme2:r9:model:0')).toBeDefined(); // ':' boundary → acme2 untouched
    expect((await listLog(journal, '__audit__')).length).toBe(1); // root audit deliberately retained
  });

  it("rejects an org id containing ':' (would break the prefix boundary)", async () => {
    await expect(purgeOrganization(new InMemoryJournal(), 'a:b')).rejects.toThrow(/must not contain/);
  });
});
