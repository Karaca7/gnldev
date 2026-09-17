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
import { sweepThreads, sweepRuns, purgeResource } from '../src/retention.js';
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
  it('purgeResource AFTER sweepRuns leaves thread state behind — and the sweep now names it', async () => {
    const journal: any = toJournal(new InMemoryStorage().runs);
    await runDurable({ runId: 'r4', journal, stopWhen: stepCountIs(6), prompt: 'x',
      threadId: 'th-D', resourceId: 'person-1', limits: limits(), tools, model: model({ sku: 'IBAN-TR55' }) } as any);

    // Normal operation: age-based retention removes the runs first.
    await sweepRuns(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    // Then the erasure request arrives. purgeResource finds threads THROUGH the person's runs, which
    // are gone, so the threadId is no longer reachable from that side.
    await purgeResource(journal, 'person-1');

    const after = await threadState(journal, 'th-D');
    expect(after.keys).toBe(2);
    expect(after.canonicals).toEqual(['createRecord: iban-tr55']); // the documented, measured gap
    // The one thing that changed: it is now discoverable from the sweep instead of being invisible.
    const res = await sweepThreads(journal, { olderThanMs: 0, now: FAR_FUTURE() });
    expect(res.orphanThreadState).toEqual(['th-D']);
  });

  it('CONTROL: purgeResource BEFORE the runs age out clears the thread state completely', async () => {
    const journal: any = toJournal(new InMemoryStorage().runs);
    await runDurable({ runId: 'r5', journal, stopWhen: stepCountIs(6), prompt: 'x',
      threadId: 'th-E', resourceId: 'person-2', limits: limits(), tools, model: model({ sku: 'IBAN-TR66' }) } as any);

    await purgeResource(journal, 'person-2');
    expect((await threadState(journal, 'th-E')).keys).toBe(0);
  });
});
