// HERMES v1 — approval-gated suggestion/learning layer. Pinned invariants:
// 1) config conflicts THROW (both switches required, generate→model, embed↔embedModelId, v1 only
//    supports 'on-approval', threshold ranges, missing listKeys)
// 2) learning transition: completed run → pending sugg (mechanism sentence REQUIRED, found:false → none);
//    AT-MOST-ONCE per runId (memo); no resourceId → no learning
// 3) merging: the same lesson on a second run does NOT open a new record, it adds evidence; a different user gets a separate record
// 4) evidence diversity: a repeat from the same user+thread+day counts as 1 effective evidence + sameSourceWarning
// 5) approval gate: approve → lesson is born; reject → it isn't; decision is FIRST-WINS
// 6) injection: an approved lesson enters the next run's system prompt; provenance `<runId>:cfg:lessons`
//    FREEZES (even when empty) — a retry of the same runId after approval still does NOT see the lesson; apply:false → never injected
// 7) under-influence tainting: if a run that had a lesson injected writes evidence to THAT lesson's suggestion, it's tainted →
//    does not count toward the effective tally
// 8) promotion: without a promotion block, the org code path never runs; with one, N distinct-user approvals
//    give birth to an org-scope PENDING sugg (not auto-applied), which once approved injects the org lesson for everyone
import { describe, it, expect } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import {
  validateSuggestionsConfig, evidenceQualityOf, suggKey, personalLessonKey, orgLessonKey,
  lessonProvenanceKey,
} from '../src/suggestions.js';
import type { SuggestionsConfig, SuggestionRecord } from '../src/suggestions.js';
import { createMockModel, finalTextResult } from './mock.js';

/** Agent model: plain final text; captures call options so we can inspect the system prompt. */
function agentModel(captured?: any[]) {
  return createMockModel(async (opts: any) => {
    captured?.push(opts);
    return finalTextResult('done');
  });
}

/** Learning model: returns a fixed lesson JSON; the call counter pins the at-most-once guarantee. */
function learnModel(payload: { found: boolean; rule?: string; mechanism?: string }, counter?: { n: number }) {
  return createMockModel(async () => {
    if (counter) counter.n += 1;
    return finalTextResult(JSON.stringify({ rule: '', mechanism: '', ...payload }));
  });
}

const LESSON = { found: true, rule: 'Always confirm the target environment before deploys.', mechanism: 'Deploy mistakes come from environment ambiguity.' };

function gnlWith(journal: InMemoryJournal, suggestions: SuggestionsConfig, captured?: any[]) {
  return createGnl({ journal, agents: { a: { model: agentModel(captured) } }, suggestions });
}

describe('HERMES config gates', () => {
  const j = new InMemoryJournal();
  it('THROWs when the switches are not boolean', () => {
    expect(() => validateSuggestionsConfig({ generate: true } as any, j)).toThrow(/two-switch|switches/);
  });
  it('generate:true + no model → THROW', () => {
    expect(() => validateSuggestionsConfig({ generate: true, apply: false } as any, j)).toThrow(/model/);
  });
  it('embed present but no embedModelId → THROW (tainting rule)', () => {
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, embed: async () => [[1]] } as any, j)).toThrow(/embedModelId/);
  });
  it("v1 only supports strategy 'on-approval' — 'batch' THROWs", () => {
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, promotion: { strategy: 'batch' } } as any, j)).toThrow(/on-approval/);
  });
  it('threshold ranges: minUsers 0 and ratio 1.5 THROW', () => {
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, promotion: { strategy: 'on-approval', threshold: { minUsers: 0 } } } as any, j)).toThrow(/minUsers/);
    expect(() => validateSuggestionsConfig({ generate: false, apply: true, promotion: { strategy: 'on-approval', threshold: { ratio: 1.5 } } } as any, j)).toThrow(/ratio/);
  });
  it('journal without listKeys + generate → THROW', () => {
    const bare = { get: async () => undefined, put: async () => {} } as any;
    expect(() => validateSuggestionsConfig({ generate: true, apply: false, model: 'x/y' } as any, bare)).toThrow(/listKeys/);
  });
});

describe('HERMES learning transition', () => {
  it('a completed run gives birth to a pending suggestion; a second call with the same runId does NOT re-invoke the model', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON, counter) });
    await gnl.run('a', { runId: 'r1', prompt: 'deploy this', resourceId: 'u1', threadId: 't1' });
    const pend = await gnl.suggestions!.list({ status: 'pending' });
    expect(pend).toHaveLength(1);
    expect(pend[0]!.rule).toBe(LESSON.rule);
    expect(pend[0]!.scope).toBe('personal');
    expect(pend[0]!.resourceId).toBe('u1');
    expect(counter.n).toBe(1);
    await gnl.run('a', { runId: 'r1', prompt: 'deploy this', resourceId: 'u1', threadId: 't1' });
    expect(counter.n).toBe(1); // at-most-once memo
    expect(await gnl.suggestions!.list({ status: 'pending' })).toHaveLength(1);
  });

  it('found:false or a lesson without a mechanism does NOT give birth to a suggestion; no resourceId means no learning', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel({ found: false }) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    expect(await gnl.suggestions!.list()).toHaveLength(0);

    const j2 = new InMemoryJournal();
    const g2 = gnlWith(j2, { generate: true, apply: true, model: learnModel({ found: true, rule: 'rule only' }) });
    await g2.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    expect(await g2.suggestions!.list()).toHaveLength(0); // mechanism is required

    const j3 = new InMemoryJournal();
    const g3 = gnlWith(j3, { generate: true, apply: true, model: learnModel(LESSON) });
    await g3.run('a', { runId: 'r1', prompt: 'x' }); // no resourceId
    expect(await g3.suggestions!.list()).toHaveLength(0);
  });

  it('the same lesson on a second run MERGES (one record, two evidence entries); a different user gets a SEPARATE record', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' });
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1', threadId: 't2' });
    const mine = await gnl.suggestions!.list({ resourceId: 'u1' });
    expect(mine).toHaveLength(1);
    expect(mine[0]!.evidence).toHaveLength(2);
    await gnl.run('a', { runId: 'r3', prompt: 'z', resourceId: 'u2', threadId: 't3' });
    expect(await gnl.suggestions!.list()).toHaveLength(2); // personal layer: a separate birth per user
  });
});

describe('HERMES evidence discipline', () => {
  it('diversity: a repeat from the same user+thread+day counts as 1 effective evidence + sameSourceWarning', () => {
    const at = Date.now();
    const q = evidenceQualityOf([
      { runId: 'r1', resourceId: 'u1', threadId: 't1', at },
      { runId: 'r2', resourceId: 'u1', threadId: 't1', at: at + 1000 },
      { runId: 'r3', resourceId: 'u1', threadId: 't1', at: at + 2000 },
    ]);
    expect(q.total).toBe(3);
    expect(q.effective).toBe(1);
    expect(q.sameSourceWarning).toBe(true);
    const q2 = evidenceQualityOf([
      { runId: 'r1', resourceId: 'u1', threadId: 't1', at },
      { runId: 'r2', resourceId: 'u2', threadId: 't2', at },
    ]);
    expect(q2.effective).toBe(2);
    expect(q2.sameSourceWarning).toBe(false);
  });

  it('under-influence tainting: a run that had the lesson injected writes TAINTED evidence to that same lesson\'s suggestion', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' });
    const [sugg] = await gnl.suggestions!.list({ status: 'pending' });
    await gnl.suggestions!.decide(sugg!.id, { approve: true, by: 'op' });
    // r2: the lesson gets injected, and the learning transition proposes the SAME lesson again → merge + tainted
    await gnl.run('a', { runId: 'r2', prompt: 'x again', resourceId: 'u1', threadId: 't1' });
    const rec = await journal.get<SuggestionRecord>(suggKey(sugg!.id));
    expect(rec!.evidence).toHaveLength(2);
    expect(rec!.evidence[1]!.tainted).toBe(true);
    const q = evidenceQualityOf(rec!.evidence);
    expect(q.tainted).toBe(1);
    expect(q.effective).toBe(1); // tainted evidence can't count toward the effective tally
  });
});

describe('HERMES approval gate + injection', () => {
  it('approve → the lesson is born and enters the NEXT run\'s system prompt; provenance freezes; reject → it is never born', async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) }, captured);
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' });
    const [sugg] = await gnl.suggestions!.list();
    const d = await gnl.suggestions!.decide(sugg!.id, { approve: true, by: 'op' });
    expect(d).toEqual({ status: 'approved', alreadyDecided: false });
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeDefined();

    captured.length = 0;
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1', threadId: 't1' });
    expect(JSON.stringify(captured)).toContain(LESSON.rule);
    const prov = await journal.get<{ ids: string[] }>(lessonProvenanceKey('r2'));
    expect(prov!.ids).toEqual([personalLessonKey('u1', sugg!.id)]);

    // reject path: a second user's suggestion is rejected → no lesson
    await gnl.run('a', { runId: 'r3', prompt: 'z', resourceId: 'u2', threadId: 't2' });
    const [s2] = await gnl.suggestions!.list({ status: 'pending' });
    await gnl.suggestions!.decide(s2!.id, { approve: false });
    expect(await journal.get(personalLessonKey('u2', s2!.id))).toBeUndefined();
  });

  it('decision is FIRST-WINS: a second decision reports alreadyDecided and returns the FIRST verdict', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    await gnl.suggestions!.decide(sugg!.id, { approve: false });
    const second = await gnl.suggestions!.decide(sugg!.id, { approve: true });
    expect(second).toEqual({ status: 'rejected', alreadyDecided: true });
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeUndefined();
  });

  it('FROZEN injection: a retry of the same runId does NOT see a lesson approved in between (an empty set also freezes)', async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) }, captured);
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' }); // ran before any lesson existed → froze empty
    const [sugg] = await gnl.suggestions!.list();
    await gnl.suggestions!.decide(sugg!.id, { approve: true });
    captured.length = 0;
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1', threadId: 't1' }); // retry with the same runId
    expect(JSON.stringify(captured)).not.toContain(LESSON.rule); // the frozen empty set wins
  });

  it('apply:false → an approved lesson is NEVER injected but the record still LIVES', async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) }, captured);
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    await gnl.suggestions!.decide(sugg!.id, { approve: true });
    captured.length = 0;
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1' });
    expect(JSON.stringify(captured)).not.toContain(LESSON.rule);
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeDefined(); // the switch doesn't delete the lesson
  });
});

describe('HERMES promotion', () => {
  async function approveFor(gnl: ReturnType<typeof createGnl>, user: string, runId: string) {
    await gnl.run('a', { runId, prompt: 'x', resourceId: user, threadId: `t-${user}` });
    const pend = await gnl.suggestions!.list({ status: 'pending', resourceId: user });
    await gnl.suggestions!.decide(pend[0]!.id, { approve: true });
  }

  it('WITHOUT a promotion block, 3 user approvals do NOT give birth to an org suggestion', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: true, model: learnModel(LESSON) });
    for (const [i, u] of ['u1', 'u2', 'u3'].entries()) await approveFor(gnl, u, `r${i}`);
    expect(await gnl.suggestions!.list({ scope: 'org' })).toHaveLength(0);
  });

  it("'on-approval': N distinct-user approvals give birth to an org-scope PENDING suggestion; once approved it injects for EVERYONE", async () => {
    const journal = new InMemoryJournal();
    const captured: any[] = [];
    const gnl = gnlWith(journal, {
      generate: true, apply: true, model: learnModel(LESSON),
      promotion: { strategy: 'on-approval', threshold: { minUsers: 3, ratio: 0.2 } },
    }, captured);
    await approveFor(gnl, 'u1', 'r1');
    await approveFor(gnl, 'u2', 'r2');
    expect(await gnl.suggestions!.list({ scope: 'org' })).toHaveLength(0); // below threshold
    await approveFor(gnl, 'u3', 'r3');
    const orgs = await gnl.suggestions!.list({ scope: 'org' });
    expect(orgs).toHaveLength(1);
    expect(orgs[0]!.status).toBe('pending'); // promotion is NOT auto-applied
    expect(orgs[0]!.quality.distinctUsers).toBe(3);

    await gnl.suggestions!.decide(orgs[0]!.id, { approve: true, by: 'admin' });
    expect(await journal.get(orgLessonKey(orgs[0]!.id))).toBeDefined();
    captured.length = 0;
    await gnl.run('a', { runId: 'r-new', prompt: 'q', resourceId: 'u9', threadId: 't9' }); // a user who never approved the lesson
    expect(JSON.stringify(captured)).toContain(LESSON.rule); // org lesson goes to everyone
  });

  it('org-echo tainting: a NEW user with the org lesson injected who proposes the same rule gets a TAINTED suggestion', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, {
      generate: true, apply: true, model: learnModel(LESSON),
      promotion: { strategy: 'on-approval', threshold: { minUsers: 3 } },
    });
    for (const [i, u] of ['u1', 'u2', 'u3'].entries()) await approveFor(gnl, u, `r${i}`);
    const [org] = await gnl.suggestions!.list({ scope: 'org' });
    await gnl.suggestions!.decide(org!.id, { approve: true });
    // u9: has no personal record, gets the org lesson injected; the learning transition echoes the same rule
    await gnl.run('a', { runId: 'r-echo', prompt: 'q', resourceId: 'u9', threadId: 't9' });
    const [echo] = await gnl.suggestions!.list({ resourceId: 'u9' });
    expect(echo).toBeDefined();
    expect(echo!.evidence[0]!.tainted).toBe(true); // the shadow can't escape the scope boundary
    expect(echo!.quality.effective).toBe(0);
  });

  it('repeated approvals do NOT give birth to the SAME org suggestion a second time (deterministic id + claim)', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, {
      generate: true, apply: false, model: learnModel(LESSON),
      promotion: { strategy: 'on-approval', threshold: { minUsers: 2 } },
    });
    for (const [i, u] of ['u1', 'u2', 'u3', 'u4'].entries()) await approveFor(gnl, u, `r${i}`);
    expect(await gnl.suggestions!.list({ scope: 'org' })).toHaveLength(1);
  });
});

describe('HERMES repair + concurrency (audit findings)', () => {
  it('decide repair: if the lesson write transiently fails, a SUBSEQUENT decide idempotently completes the effects', async () => {
    class FlakyJournal extends InMemoryJournal {
      failPutOf: string | undefined;
      override async put(key: string, value: unknown): Promise<void> {
        if (this.failPutOf && key === this.failPutOf) {
          this.failPutOf = undefined;
          throw new Error('transient journal hiccup');
        }
        return super.put(key, value);
      }
    }
    const journal = new FlakyJournal();
    const gnl = gnlWith(journal as InMemoryJournal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    journal.failPutOf = personalLessonKey('u1', sugg!.id);
    await expect(gnl.suggestions!.decide(sugg!.id, { approve: true })).rejects.toThrow(/transient/);
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeUndefined(); // left half-done
    const second = await gnl.suggestions!.decide(sugg!.id, { approve: true });
    expect(second.alreadyDecided).toBe(true);
    expect(second.status).toBe('approved');
    expect(await journal.get(personalLessonKey('u1', sugg!.id))).toBeDefined(); // the repair gave birth to the lesson
  });

  it('a REAL concurrent decision race: a single verdict, the lesson\'s existence consistent with it', async () => {
    const journal = new InMemoryJournal();
    const gnl = gnlWith(journal, { generate: true, apply: false, model: learnModel(LESSON) });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    const [sugg] = await gnl.suggestions!.list();
    const [a, b] = await Promise.all([
      gnl.suggestions!.decide(sugg!.id, { approve: true, by: 'op-a' }),
      gnl.suggestions!.decide(sugg!.id, { approve: false, by: 'op-b' }),
    ]);
    expect(a.status).toBe(b.status); // both operators see the same verdict
    expect([a.alreadyDecided, b.alreadyDecided].filter((x) => !x)).toHaveLength(1); // a single winner
    const rec = await journal.get<SuggestionRecord>(suggKey(sugg!.id));
    expect(rec!.status).toBe(a.status);
    const lesson = await journal.get(personalLessonKey('u1', sugg!.id));
    if (a.status === 'approved') expect(lesson).toBeDefined();
    else expect(lesson).toBeUndefined();
  });

  it('embed similarity: DIFFERENTLY worded lessons with the same meaning MERGE via the vector path', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const payloads = [
      { found: true, rule: 'Confirm the deploy target first.', mechanism: 'Ambiguity causes mistakes.' },
      { found: true, rule: 'Before deploying, verify which environment you target.', mechanism: 'Ambiguity causes mistakes.' },
    ];
    const seqModel = createMockModel(async () => finalTextResult(JSON.stringify(payloads[Math.min(counter.n++, 1)])));
    const gnl = gnlWith(journal, {
      generate: true, apply: false, model: seqModel,
      embed: async (texts: string[]) => texts.map(() => [1, 0]), // fixed vector → cosine 1.0
      embedModelId: 'test-embed',
    });
    await gnl.run('a', { runId: 'r1', prompt: 'x', resourceId: 'u1' });
    await gnl.run('a', { runId: 'r2', prompt: 'y', resourceId: 'u1' });
    const mine = await gnl.suggestions!.list({ resourceId: 'u1' });
    expect(mine).toHaveLength(1); // no exact match, but the vector path merges them
    expect(mine[0]!.evidence).toHaveLength(2);
  });

  it("apply:true on a journal without listKeys also THROWs (no silent-inert switches allowed)", () => {
    const bare = { get: async () => undefined, put: async () => {} } as any;
    expect(() => createGnl({ journal: bare, agents: { a: { model: agentModel() } }, suggestions: { generate: false, apply: true } }))
      .toThrow(/listKeys/);
  });
});
