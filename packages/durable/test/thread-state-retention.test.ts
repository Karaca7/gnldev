// THREAD STATE vs RETENTION — what reaches `xthr:` and what does not.
//
// `xthr:<threadId>:` holds five families: the thread idempotency window (`args-`), dup markers
// (`dup-`), semantic records (`sem-`, which carry the canonical sentence built from the caller's
// identity values), tombstones (`semtomb-`) and judge verdicts (`semjudge-`). `purgeThread` takes all
// of them in one sweep and that part works — the gap is DISCOVERY, and it is pinned here rather than
// quietly closed, because the fix direction is "delete more data" and that is the caller's call.
//
//   sweepThreads   the only AGE-based sweep, finds threads by listing `mem:`  → misses everything else
//   purgeResource  the person-erasure surface, finds threads through the person's RUNS → decays once
//                  sweepRuns has removed them
//   ttlMs          a read-side filter; expired records stop being candidates and stay on disk
//
// What changed: none of those deletions moved. `sweepThreads` now REPORTS what it cannot reach
// (`orphanThreadState`), so "I swept nothing" and "I could not see it" stop producing identical
// numbers. Every "still there" assertion below is deliberate, not an aspiration.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryStorage, toJournal } from '../src/index.js';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { sweepThreads, sweepRuns, purgeResource, purgeThread, listOrphanThreadState } from '../src/retention.js';
import { MEM_LEAVES } from '../src/memory.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    const v = new Array(32).fill(0); v[h % 32] = 1; v[(h >> 5) % 32] += 0.5; return v;
  });

const limits = (extra: Record<string, unknown> = {}) => ({
  sideEffectDuplicates: {
    action: 'suspend' as const, scope: 'thread' as const, ...extra,
    semantic: { embed: fakeEmbed, embedModelId: 'ret' },
  },
});
const tools = { createRecord: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
const model = (args: unknown) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult('createRecord', 'c1', args) : finalTextResult('ok'));

/** Keys and canonical sentences still held under one thread — the PII surface, counted. */
async function threadState(journal: any, threadId: string) {
  const keys: string[] = await journal.listKeys(`xthr:${threadId}:`);
  const canonicals: string[] = [];
  for (const k of keys) {
    const v = await journal.get<any>(k);
    if (typeof v?.canonical === 'string') canonicals.push(v.canonical);
  }
  return { keys: keys.length, canonicals };
}

const FAR_FUTURE = () => Date.now() + 10_000_000;

describe('sweepThreads and thread state it cannot discover', () => {
  it('a thread with no BasicMemory is NOT swept — and is now named instead of silently missing', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r1', journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 'th-A',
      limits: limits(), tools, model: model({ sku: 'PATIENT-123' }) } as any);

    const res = await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect(res.scanned).toBe(0);
    expect(res.purged).toEqual([]);
    // The point of the field: 'nothing to sweep' and 'could not see it' used to be the same report.
    expect(res.orphanThreadState).toEqual(['th-A']);
    // Still there, ON PURPOSE — this sweep does not delete what it did not age.
    const after = await threadState(journal, 'th-A');
    expect(after.keys).toBe(2); // the dup marker and the semantic record
    expect(after.canonicals).toEqual(['createRecord: patient-123']);
  });

  it('CONTROL: a thread WITH BasicMemory is swept whole, and is not reported as orphaned', async () => {
    const journal = new InMemoryJournal();
    await journal.put('mem:th-B:messages', [{ role: 'user', content: 'selam', ts: 1000 }]);
    await runDurable({ runId: 'r2', journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 'th-B',
      limits: limits(), tools, model: model({ sku: 'ABC' }) } as any);

    const res = await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect(res.purged).toEqual(['th-B']);
    expect(res.orphanThreadState).toEqual([]); // a thread purged in THIS round is not an orphan
    expect((await threadState(journal, 'th-B')).keys).toBe(0);
  });

  it('ttlMs expires a record for READING; it does not delete it', async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r3', journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 'th-C',
      limits: limits({ ttlMs: 1 }), tools, model: model({ sku: 'SECRET-9' }) } as any);
    const after = await threadState(journal, 'th-C');
    expect(after.keys).toBe(2);
    expect(after.canonicals).toEqual(['createRecord: secret-9']); // a short ttl is not a retention policy
  });

  it("a threadId containing ':' is recovered from the key, not split on the separator", async () => {
    const journal = new InMemoryJournal();
    await runDurable({ runId: 'r6', journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 'tenant:7:chat',
      limits: limits(), tools, model: model({ sku: 'X' }) } as any);
    const res = await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect(res.orphanThreadState).toEqual(['tenant:7:chat']);
  });
});

describe('person erasure after run retention', () => {
  it('purgeResource AFTER sweepRuns reaches the thread anyway — the ownership trace outlives the run', async () => {
    const journal: any = toJournal(new InMemoryStorage().runs);
    await runDurable({ runId: 'r4', journal, stopWhen: stepCountIs(6), prompt: 'x',
      threadId: 'th-D', resourceId: 'person-1', limits: limits(), tools, model: model({ sku: 'IBAN-TR55' }) } as any);

    // Normal operation: age-based retention removes the runs first.
    await sweepRuns(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    // Then the erasure request arrives. purgeResource finds threads THROUGH the person's runs — and
    // those are gone. This used to end here: the measured residue was `keys: 2` carrying
    // 'createRecord: iban-tr55', a person's own argument surviving their erasure request because
    // two correct operations ran in the wrong order.
    await purgeResource(journal, 'person-1');

    const after = await threadState(journal, 'th-D');
    expect(after.keys, 'the thread is reachable through the trace the sweep left').toBe(0);
    expect(after.canonicals).toEqual([]);
    // The trace names a person, so it must not outlive them either.
    expect(await journal.listKeys('resthr:person-1:')).toEqual([]);
    // Nothing orphaned: the sweep has nothing left to report for this thread.
    const res = await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect(res.orphanThreadState).toEqual([]);
  });

  it('a run with NO resourceId still orphans its thread — orphanThreadState is why that is visible', async () => {
    // The trace can only be written when the run says whose it is. An anonymous run (no resourceId)
    // leaves thread state that NO erasure request can reach, because no person owns it — there is
    // nothing to erase it BY. That case is why `orphanThreadState` still earns its place: the field
    // is not made redundant by the fix above, it covers precisely what the fix cannot.
    const journal: any = toJournal(new InMemoryStorage().runs);
    await runDurable({ runId: 'r6', journal, stopWhen: stepCountIs(6), prompt: 'x',
      threadId: 'th-F', limits: limits(), tools, model: model({ sku: 'ANON-1' }) } as any);
    await sweepRuns(journal, { olderThanMs: 0, now: FAR_FUTURE() });

    expect((await threadState(journal, 'th-F')).keys).toBeGreaterThan(0);
    const res = await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect(res.orphanThreadState, 'an ownerless thread is exactly what this field is for').toEqual(['th-F']);
  });

  it('CONTROL: purgeResource BEFORE the runs age out clears the thread state completely', async () => {
    const journal: any = toJournal(new InMemoryStorage().runs);
    await runDurable({ runId: 'r5', journal, stopWhen: stepCountIs(6), prompt: 'x',
      threadId: 'th-E', resourceId: 'person-2', limits: limits(), tools, model: model({ sku: 'IBAN-TR66' }) } as any);

    await purgeResource(journal, 'person-2');
    expect((await threadState(journal, 'th-E')).keys).toBe(0);
  });

  it('listOrphanThreadState reports the same threads WITHOUT deleting anything', async () => {
    // The field exists to name what no sweep can reach; a number you can only obtain by running a
    // DELETE is not readable in any useful sense. This pins the read-only half: same answer as the
    // sweep, and the journal is byte-identical afterwards.
    const journal: any = toJournal(new InMemoryStorage().runs);
    await runDurable({ runId: 'r7', journal, stopWhen: stepCountIs(6), prompt: 'x',
      threadId: 'th-G', limits: limits(), tools, model: model({ sku: 'ANON-2' }) } as any);
    await sweepRuns(journal, { olderThanMs: 0, now: FAR_FUTURE() });

    const before = await journal.listKeys('');
    const orphans = await listOrphanThreadState(journal);
    const after = await journal.listKeys('');

    expect(orphans.threadIds).toEqual(['th-G']);
    expect(after, 'a read-only listing deleted keys').toEqual(before);
    // …and it agrees with the sweep, which is what makes it safe to read instead.
    expect((await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() })).orphanThreadState)
      .toEqual(orphans.threadIds);
  });

  it('a `mem:` leaf this build cannot read is NAMED, not silently counted as a missing thread', async () => {
    // The drift this closes: retention recovers a threadId out of `mem:<threadId>:<leaf>` by matching
    // a known leaf, because a threadId may contain ':' itself. An unmatched leaf therefore does not
    // fail — the thread just stops existing as far as the scan is concerned, and a thread that does
    // not exist is reported ORPHANED with its memory sitting right beside its dedup state.
    //
    // Measured before the leaf list was shared with memory.ts: `mem:th-new:summary` +
    // `xthr:th-new:sem-…` reported `threadIds: ['th-new']`, `unrecognisedKeys: []` — a wrong answer
    // with nothing on the report to suggest a key had been skipped.
    //
    // The structural half (one shared MEM_LEAVES) stops a NEW leaf from drifting. This half catches
    // the other road in: a key built by hand instead of through memKey — which rag's semantic-memory
    // does today.
    const journal: any = toJournal(new InMemoryStorage().runs);
    await journal.put('mem:th-new:summary', { v: 1 });
    await journal.put('xthr:th-new:sem-pay-abc', { v: 1 });

    const orphans = await listOrphanThreadState(journal);
    expect(orphans.unrecognisedKeys, 'the skipped key must be named').toContain('mem:th-new:summary');

    // CONTROL: every leaf the memory port can actually write must be recognised, or this gate would
    // report healthy threads forever. This is the binding — add a leaf to MEM_LEAVES without
    // teaching retention, and it turns red here rather than in someone's orphan report.
    for (const leaf of MEM_LEAVES) {
      const j2: any = toJournal(new InMemoryStorage().runs);
      await j2.put(`mem:th-ok:${leaf}`, { v: 1 });
      await j2.put('xthr:th-ok:sem-pay-abc', { v: 1 });
      const r = await listOrphanThreadState(j2);
      expect(r.unrecognisedKeys, `leaf '${leaf}' is written by memKey and must be readable here`).toEqual([]);
      expect(r.threadIds, `leaf '${leaf}' identifies a LIVE thread, not an orphan`).toEqual([]);
    }
  });

  it('a purged thread takes its ownership traces with it — a trace outlives the run, not the thread', async () => {
    // The trace exists so an erasure request can still reach a thread whose runs retention deleted.
    // Once the THREAD itself is gone it identifies nothing — and it is not inert while it waits:
    // `resthr:<resourceId>:<threadId>` names a person, so a dead pointer is a personal-data record
    // kept for no reason. Measured before this was closed: purgeThread left the thread at zero keys
    // and its trace still on disk, and since sweepThreads deletes through purgeThread, every
    // age-swept thread left one behind with nothing able to clear them.
    const journal: any = toJournal(new InMemoryStorage().runs);
    for (const [person, thread] of [['p-1', 'th-1'], ['p-2', 'th-2']]) {
      await runDurable({ runId: `r-${person}`, journal, stopWhen: stepCountIs(6), prompt: 'x',
        threadId: thread, resourceId: person, limits: limits(), tools, model: model({ sku: `S-${person}` }) } as any);
    }
    await sweepRuns(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect((await journal.listKeys('resthr:')).sort()).toEqual(['resthr:p-1:th-1', 'resthr:p-2:th-2']);

    await purgeThread(journal, 'th-1');
    expect(await journal.listKeys('resthr:'), "the purged thread's trace stayed behind").toEqual(['resthr:p-2:th-2']);

    // AND the one still standing is left alone: a trace whose thread still holds state is not dead,
    // it is the thing that will carry an erasure request there. Clearing it would re-open the gap.
    expect((await threadState(journal, 'th-2')).keys).toBeGreaterThan(0);
  });

  it('a threadId that is a PREFIX of another keeps its neighbour intact', async () => {
    // `deleteExactKey`, not a prefix delete: `resthr:p:th-1` is a prefix of `resthr:p:th-10`, so a
    // plain delete would erase another thread's trace — and that person's erasure request would then
    // walk past their own data. The same one-character boundary the backend matrix tests, one level up.
    const journal: any = toJournal(new InMemoryStorage().runs);
    for (const [person, thread] of [['p-1', 'th-1'], ['p-1', 'th-10']]) {
      await runDurable({ runId: `rx-${thread}`, journal, stopWhen: stepCountIs(6), prompt: 'x',
        threadId: thread, resourceId: person, limits: limits(), tools, model: model({ sku: `S-${thread}` }) } as any);
    }
    await sweepRuns(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    await purgeThread(journal, 'th-1');
    expect(await journal.listKeys('resthr:'), 'purging th-1 took th-10 with it').toEqual(['resthr:p-1:th-10']);
  });

  it('a failed trace scan THROWS rather than reporting a clean erasure', async () => {
    // The erasure path had `.catch(() => [])` on its trace scan. An empty list and a failed read are
    // the same value, so a transient listKeys error made purgeResource return a count while a record
    // built from that person's arguments stayed on disk — measured: it returned normally and
    // `pay: iban-tr55` was still there. The caller then tells the person their data is gone.
    //
    // A throw does not save the data; nothing can, the scan is what finds it. What it saves is the
    // TRUTH: the request failed and has to be retried, instead of being filed as done.
    const base: any = toJournal(new InMemoryStorage().runs);
    await base.put('resthr:p-1:th-1', { at: 1 });
    await base.put('xthr:th-1:sem-pay-h1', { v: 1, canonical: 'pay: iban-tr55' });
    const flaky: any = new Proxy(base, {
      get(t, k) {
        if (k !== 'listKeys') return Reflect.get(t, k);
        return async (prefix: string) => {
          if (prefix.startsWith('resthr:')) throw new Error('connection reset');
          return t.listKeys(prefix);
        };
      },
    });

    await expect(purgeResource(flaky, 'p-1'), 'a half-finished erasure reported success').rejects.toThrow(/connection reset/);
    // The data is still there — that is WHY the throw matters. A silent success here is a person
    // told their record is gone while it is not.
    expect(await base.listKeys('xthr:th-1:')).toEqual(['xthr:th-1:sem-pay-h1']);
  });

  it('an xthr: family this build does not know is REPORTED, not dropped', async () => {
    // XTHR_FAMILIES is a fixed list, so a family added by a newer @gnldev/durable is unparseable
    // here — and the old behaviour was to skip it in silence. That is the one thing this report
    // cannot afford: its entire claim is "here is state no sweep can reach", and a key it cannot
    // classify is the most unreachable state there is. Measured before the fix: two keys on disk,
    // one named in the report, the other simply absent.
    //
    // Reported as RAW KEYS, not as a guessed threadId: the family boundary is precisely what is
    // unknown, and a threadId may contain ':' — any split here would be a guess wearing the clothes
    // of a fact.
    const journal = new InMemoryJournal();
    await journal.put('xthr:th-known:sem-pay-h1', { v: 1 });
    await journal.put('xthr:th-future:newfam-pay-h2', { v: 1 });

    const report = await listOrphanThreadState(journal);
    expect(report.threadIds).toEqual(['th-known']);
    expect(report.unrecognisedKeys, 'a key from an unknown family vanished').toEqual(['xthr:th-future:newfam-pay-h2']);

    // The sweep carries the same signal, so an operator reading either one sees the whole picture.
    const swept = await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect(swept.unrecognisedXthrKeys).toEqual(['xthr:th-future:newfam-pay-h2']);

    // And a repo with only known families reports nothing — a field that is always populated is a
    // banner, not a signal.
    const clean = new InMemoryJournal();
    await clean.put('xthr:th-a:dup-x-h', { v: 1 });
    expect((await listOrphanThreadState(clean)).unrecognisedKeys).toEqual([]);
  });
});

describe('a thread id is not a prefix — purging one must not take its descendants', () => {
  // ':' is legal in a thread id on purpose (memory.ts says so, and thread-id-boundary.test.ts pins
  // it), so 'tenant:7' and 'tenant:7:chat' are two legitimate conversations whose keys nest. The
  // delete used `deletePrefix('mem:tenant:7:')`, which is not a boundary between them.
  //
  // Measured before the fix: purging 'tenant:7' removed six keys — the neighbour's three among them
  // — and the sweep reported only 'tenant:7'. No poisoned id, no reserved word, and the victim's
  // data was fresh. purgeResource calls this function, so the same collision sat on the erasure
  // path: one person's deletion request destroying another person's conversation.
  const seed = async (j: any) => {
    await j.put('mem:tenant:7:messages', [{ role: 'user', content: 'PARENT' }]);
    await j.put('mem:tenant:7:working', 'parent wm');
    await j.put('xthr:tenant:7:sem-pay-a', { v: 1 });
    await j.put('mem:tenant:7:chat:messages', [{ role: 'user', content: 'CHILD' }]);
    await j.put('mem:tenant:7:chat:working', 'child wm');
    await j.put('xthr:tenant:7:chat:sem-pay-b', { v: 1 });
  };

  it('purgeThread takes its own keys in both namespaces and leaves the descendant whole', async () => {
    const journal: any = toJournal(new InMemoryStorage().runs);
    await seed(journal);

    const deleted = await purgeThread(journal, 'tenant:7');
    expect(deleted, 'exactly its own three keys').toBe(3);

    const left = (await journal.listKeys('')).sort();
    expect(left).toEqual([
      'mem:tenant:7:chat:messages',
      'mem:tenant:7:chat:working',
      'xthr:tenant:7:chat:sem-pay-b',
    ]);
    // The data itself, not just the key: a surviving key with a lost value is the same loss.
    expect(await journal.get('mem:tenant:7:chat:messages')).toEqual([{ role: 'user', content: 'CHILD' }]);
  });

  it('the DESCENDANT can still be purged on its own, and the parent survives that', async () => {
    // The mirror case. A boundary that only holds in one direction is not a boundary — and this is
    // the direction where the shorter id is a prefix of nothing, so a naive fix passes the test
    // above and fails here.
    const journal: any = toJournal(new InMemoryStorage().runs);
    await seed(journal);

    const deleted = await purgeThread(journal, 'tenant:7:chat');
    expect(deleted).toBe(3);
    expect((await journal.listKeys('')).sort()).toEqual([
      'mem:tenant:7:messages', 'mem:tenant:7:working', 'xthr:tenant:7:sem-pay-a',
    ]);
  });

  it("an unreadable leaf under a DESCENDANT is left alone; one under our own id is taken", async () => {
    // The ambiguous case, and the reason it resolves the way it does. A leaf this build cannot name
    // ('summary') gives no owner, so the key text is all there is:
    //   mem:tenant:7:summary        → one segment left → can only be OUR unknown leaf → take it
    //   mem:tenant:7:chat:summary   → still contains ':' → indistinguishable from a descendant's
    //                                 key, and guessing there is how a live thread dies → leave it
    // Erring the other way costs data; erring this way costs a key that `listOrphanThreadState`
    // already reports by name.
    const journal: any = toJournal(new InMemoryStorage().runs);
    await journal.put('mem:tenant:7:messages', [{ role: 'user', content: 'PARENT' }]);
    await journal.put('mem:tenant:7:summary', 'our own unreadable leaf');
    await journal.put('mem:tenant:7:chat:summary', "the descendant's unreadable leaf");

    await purgeThread(journal, 'tenant:7');
    expect((await journal.listKeys('')).sort()).toEqual(['mem:tenant:7:chat:summary']);
  });

  it('with no descendant it is still ONE deletePrefix per namespace, not a key at a time', async () => {
    // The fast path is a claim in the comment, so it is pinned here. Without it the common case —
    // every thread that has no descendant — pays a listing plus a round-trip per key on a nightly
    // job, and nobody would notice because the RESULT is identical.
    const inner: any = toJournal(new InMemoryStorage().runs);
    let prefixDeletes = 0;
    const counting: any = new Proxy(inner, {
      get(t, p) {
        if (p === 'deletePrefix') return (...a: unknown[]) => { prefixDeletes++; return (t as any).deletePrefix(...a); };
        const v = (t as any)[p];
        return typeof v === 'function' ? v.bind(t) : v;
      },
    });
    // TWO keys in one namespace on purpose: with one, the per-key path also makes one call and the
    // counter cannot tell the two paths apart. (It could not, first time round — the mutation that
    // removes the fast path stayed green until this line had a second key.)
    await counting.put('mem:solo:messages', [{ role: 'user', content: 'x' }]);
    await counting.put('mem:solo:working', 'wm');
    await counting.put('xthr:solo:sem-pay-a', { v: 1 });

    await purgeThread(counting, 'solo');
    expect(prefixDeletes, 'one per namespace — mem: and xthr: — not one per key').toBe(2);
  });

  it('CONTROL: with no descendant, nothing changes — including the single-call fast path', async () => {
    // A guard that makes the common case slower or different is a cost with no buyer. With no
    // neighbour under the prefix this must stay exactly what it was: one deletePrefix per namespace.
    const journal: any = toJournal(new InMemoryStorage().runs);
    await journal.put('mem:solo:messages', [{ role: 'user', content: 'x' }]);
    await journal.put('mem:solo:working', 'wm');
    await journal.put('xthr:solo:sem-pay-a', { v: 1 });

    expect(await purgeThread(journal, 'solo')).toBe(3);
    expect(await journal.listKeys('')).toEqual([]);
  });
});
