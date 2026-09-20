// ONE broken `semanticIdentity` declaration, FOUR consumers — this file pins all of them, because
// the fix for the first one did not reach the other three and the harshest was still open.
//
// The root cause is one line: identity values go through `String(v)`, so a key pointing at an object
// becomes '[object Object]' and a key that is absent becomes '' — on EVERY call. Every layer that
// compares declared identity then reports "same job" for jobs that have nothing in common.
//
// What each consumer does with that, measured rather than reasoned:
//
//   semantic gate     → a question, on every call, with the scan counters at zero (fixed earlier)
//   XID, main path    → NOT a question, a DECISION: refused under `block`, silently not executed
//                       under `skip`. Needs no semantic config at all — `semanticIdentity` plus a
//                       resourceId is enough — so it reaches deployments with no embedder. Its scope
//                       is the PERSON and it outlives the thread (xid.ts), so one bad declaration
//                       locks that person across every channel.
//   confirm decoration→ text a human reads, asserting "the SAME business identity was already
//                       completed" about two unrelated jobs. Reachable after the write side is
//                       closed, via records a PRE-FIX build already wrote — which is what an
//                       upgraded deployment still has in its journal.
//   batch preflight   → every item classified as "already completed in another channel": fresh 0 of 3
//
// The controls matter as much as the cases: a sound declaration must keep every one of these
// behaviors, including the legitimate partial-empty identity (an optional key absent on both sides).
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { readIncidents } from '../src/incidents.js';
import { createBatch } from '../src/batch.js';
import { writeXid } from '../src/xid.js';
import { semKey } from '../src/semantic-dup.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const model = (toolName: string, callId: string, args: unknown) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult(toolName, callId, args) : finalTextResult('ok'));

const fakeEmbed = async (texts: string[]): Promise<number[][]> =>
  texts.map((t) => {
    let h = 0;
    for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    const v = new Array(32).fill(0); v[h % 32] = 1; v[(h >> 5) % 32] += 0.5; return v;
  });

const semLimits = (modelId: string) => ({
  sideEffectDuplicates: {
    action: 'suspend' as const, scope: 'thread' as const,
    semantic: { embed: fakeEmbed, embedModelId: modelId },
  },
});

/** Reads the suspend question's text out of the journal (it lives on the sentinel, not the incident). */
async function suspendReason(journal: InMemoryJournal, runId: string): Promise<string> {
  let reason = '';
  for (const k of (await journal.listKeys('')).filter((x) => x.includes(runId))) {
    const r = (await journal.get<any>(k))?.output?.__gnl_suspend?.reason;
    if (typeof r === 'string') reason = r;
  }
  return reason;
}

describe('a broken identity declaration must not reach the XID layer', () => {
  /** Two DIFFERENT jobs, two separate runs (XID only speaks across runs), one resourceId. */
  async function twoJobs(action: 'block' | 'skip', keys: string[]) {
    const journal = new InMemoryJournal();
    let executed = 0;
    const tools = { act: { sideEffect: true, semanticIdentity: { keys }, execute: async () => { executed++; return { ok: 1 }; } } };
    // NO `semantic` block: XID is deterministic and runs without an embedder. That is the point.
    const limits = { sideEffectDuplicates: { action, scope: 'thread' as const } };
    const go = (runId: string, args: unknown, cid: string) =>
      runDurable({ runId, journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 't', resourceId: 'u-1',
        limits, tools, model: model('act', cid, args) } as any);
    await go('x1', { userId: 'u-7' }, 'c1');
    let threw = false;
    try { await go('x2', { userId: 'u-99' }, 'c2'); } catch { threw = true; }
    return { executed, threw, inc: await readIncidents(journal, 'x2') };
  }

  it("under `block` a misspelled key used to REFUSE an unrelated job; now it runs and says why", async () => {
    const r = await twoJobs('block', ['userID']); // the args carry 'userId'
    expect(r.executed).toBe(2);
    expect(r.threw).toBe(false);
    expect(r.inc.some((i) => (i.detail as any)?.reason === 'identity-unusable')).toBe(true);
  });

  it('under `skip` it used to swallow the job silently — the most expensive direction there is', async () => {
    const r = await twoJobs('skip', ['userID']);
    expect(r.executed).toBe(2);
    expect(r.inc.some((i) => i.action === 'skip')).toBe(false);
  });

  it('CONTROL: a sound declaration with different identities is untouched (no false positive)', async () => {
    const r = await twoJobs('block', ['userId']);
    expect(r.executed).toBe(2);
  });

  it('CONTROL: a sound declaration with the SAME identity still blocks — XID keeps doing its job', async () => {
    const journal = new InMemoryJournal();
    let executed = 0;
    const tools = { act: { sideEffect: true, semanticIdentity: { keys: ['userId'] }, execute: async () => { executed++; return { ok: 1 }; } } };
    const limits = { sideEffectDuplicates: { action: 'block' as const, scope: 'thread' as const } };
    const go = (runId: string, args: unknown, cid: string) =>
      runDurable({ runId, journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 't', resourceId: 'u-1',
        limits, tools, model: model('act', cid, args) } as any);
    await go('s1', { userId: 'u-7', note: 'a' }, 'c1');
    // Different args (so the hash differs and layers 1-4 stay quiet), same declared identity.
    await expect(go('s2', { userId: 'u-7', note: 'b' }, 'c2')).rejects.toThrow(/another channel/);
    expect(executed).toBe(1);
  });
});

describe("a broken identity declaration must not decorate a confirm question", () => {
  it('a record written by a PRE-FIX build is no longer read back into the question', async () => {
    const journal = new InMemoryJournal();
    // Exactly what the old code path would have stored: an identity that collapsed to ''.
    const canonical = 'act: ';
    const [vec] = await fakeEmbed([canonical]);
    await journal.put(semKey('t', 'act', 'OLDHASH'), {
      v: 1, toolName: 'act', argsHash: 'OLDHASH', embedModelId: 'up-model', templateVersion: '1',
      canonical, vecB64: Buffer.from(new Float32Array(vec!).buffer).toString('base64'),
      identity: { userID: '' }, amounts: {}, discriminators: {}, firstToolCallId: 'old-call', at: Date.now(),
    });
    const tools = { act: { sideEffect: true, confirm: true, semanticIdentity: { keys: ['userID'] }, execute: async () => ({ ok: 1 }) } };
    await runDurable({ runId: 'up1', journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 't',
      limits: semLimits('up-model'), tools, model: model('act', 'c1', { userId: 'u-99' }) } as any);

    const reason = await suspendReason(journal, 'up1');
    expect(reason).toContain('requires explicit confirmation');
    expect(reason).not.toContain('SAME business identity'); // the false claim about an unrelated job
  });

  /** Runs a confirm tool twice in one thread: first approved (writes the record), then a fresh call. */
  async function confirmTwice(keys: string[], a1: Record<string, unknown>, a2: Record<string, unknown>, modelId: string) {
    const journal = new InMemoryJournal();
    let executed = 0;
    const tools = { act: { sideEffect: true, confirm: true, semanticIdentity: { keys }, execute: async () => { executed++; return { ok: 1 }; } } };
    const go = (runId: string, args: unknown, cid: string, approvals?: unknown) =>
      runDurable({ runId, journal, stopWhen: stepCountIs(6), prompt: 'x', threadId: 't',
        limits: semLimits(modelId), tools, model: model('act', cid, args), ...(approvals ? { approvals } : {}) } as any);
    await go('a1', a1, 'c1');
    await go('a1', a1, 'c1', { c1: true });
    await go('a2', a2, 'c2');
    return { executed, reason: await suspendReason(journal, 'a2') };
  }

  it('CONTROL: a sound declaration still decorates the question (the feature is not disabled)', async () => {
    const r = await confirmTwice(['userId'], { userId: 'u-7', note: 'a' }, { userId: 'u-7', note: 'b' }, 'ok-model');
    expect(r.executed).toBe(1);
    expect(r.reason).toContain('SAME business identity');
  });

  it('CONTROL: a legitimate PARTIAL-empty identity still decorates it (optional key absent on both sides)', async () => {
    const r = await confirmTwice(['sku', 'warehouse'], { sku: 'ABC', note: 'a' }, { sku: 'ABC', note: 'b' }, 'pk-model');
    expect(r.reason).toContain('SAME business identity');
  });
});

describe('a broken identity declaration must not poison a batch preflight', () => {
  const cfg = (keys: string[]) => ({
    tool: {
      description: 'pay', sideEffect: true, recover: async () => ({ done: false as const }),
      semanticIdentity: { keys }, effectClass: 'transactional' as const,
      execute: async () => ({ paid: true }),
    },
    toolName: 'pay', itemKey: (i: any) => i.ref, resourceId: 'acct-1',
  });
  const three = [{ ref: 'F-1', amount: 10 }, { ref: 'F-2', amount: 20 }, { ref: 'F-3', amount: 30 }];

  it('a misspelled key used to classify EVERY item as "already done in another channel" (fresh 0 of 3)', async () => {
    const journal = new InMemoryJournal();
    // One cross-channel record, itself written under the broken declaration.
    await writeXid(journal, { resourceId: 'acct-1', toolName: 'pay', identity: { reference: '' }, amounts: {}, channel: 'chat' }, 'other-run', 'old-call');
    const p = await createBatch(journal, cfg(['reference']) as any).preflight('bx', three);
    expect(p.fresh).toBe(3);
    expect(p.xidHits).toHaveLength(0);

    // ...and the plan SAYS the column is empty because nothing was checked, not because it was
    // clean. Without this, an operator reads `fresh: 3, xidHits: 0` as "three new payments, no
    // cross-channel duplicates" — when in fact the cross-channel check did not run at all. The
    // guard being silent is the same failure as the guard being absent, one report later.
    expect(p.xidIdentityUnusable?.map((r) => r.itemKey)).toEqual(['F-1', 'F-2', 'F-3']);
    expect(p.xidIdentityUnusable?.[0]?.detail ?? '').toMatch(/none of the declared identity keys/);
  });

  it('CONTROL: a sound declaration still reports the real cross-channel hit, and only that one', async () => {
    const journal = new InMemoryJournal();
    await writeXid(journal, { resourceId: 'acct-1', toolName: 'pay', identity: { ref: 'f-2' }, amounts: {}, channel: 'chat' }, 'other-run', 'old-call');
    const p = await createBatch(journal, cfg(['ref']) as any).preflight('bo', three);
    expect(p.xidHits.map((h) => h.itemKey)).toEqual(['F-2']);
    expect(p.fresh).toBe(2);
    // The other half of the same signal: a sound declaration must NOT populate the field. A flag
    // that is always set carries no information, and would make the report above unreadable.
    expect(p.xidIdentityUnusable).toBeUndefined();
  });

  it('a Date identity does not change meaning when the worker moves zone', async () => {
    // The last branch of the same root cause, and the one `String(v)` hides best: an object renders
    // as '[object Object]' and is obviously broken, while a Date renders as a plausible, readable
    // timestamp — in the HOST'S LOCAL ZONE. Two workers in two zones then read one job as two.
    //
    // It survives the guards above because a Date is not "unusable": it carries a real instant. It
    // is the RENDERING that loses the identity, not the value.
    //
    // A model-generated argument cannot arrive here as a Date (JSON makes it an ISO string on the
    // way in), so the exposure is programmatic callers — which is the shape of a database row whose
    // timestamp column comes back as a Date object.
    const { normalizeId } = await import('../src/semantic-dup.js');
    const instant = new Date('2026-01-01T00:00:00.000Z');
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Europe/Istanbul';
      const istanbul = normalizeId(instant);
      process.env.TZ = 'UTC';
      const utc = normalizeId(instant);
      expect(istanbul, 'the same instant must identify the same job in every zone').toBe(utc);
      expect(utc).toBe('2026-01-01t00:00:00.000z');

      // And the two doors into the layer must agree: a caller passing the Date straight through and
      // a model whose argument was serialised must land on ONE identity, or the protection splits in
      // half along the road the call happened to take.
      const viaJson = normalizeId(JSON.parse(JSON.stringify({ at: instant })).at);
      expect(viaJson).toBe(utc);

      // An Invalid Date carries no instant at all. It must not normalize to the TEXT 'invalid date',
      // which would make every unparseable date collide as though they were one job.
      expect(normalizeId(new Date('not a date'))).toBe('');
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
  });
});
