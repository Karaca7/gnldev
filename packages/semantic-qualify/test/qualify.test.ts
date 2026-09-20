// THE QUALIFICATION BENCH — what this file pins:
// 1) The exam is BLIND: no label, id or filename reaches the judge, and the order is shuffled
//    deterministically (so the shuffle itself cannot vary between runs)
// 2) Scoring reads the SAME exported constants the runtime enforces — one contract, not two copies
// 3) An unparsed answer is never credited: silence cannot pass an exam
// 4) Recall is measured on PARAPHRASE pairs only, so credit for dup-exact cannot carry a weak judge
// 5) fixtureSetId is a content hash: reordering keeps it, changing content changes it
import { describe, it, expect } from 'vitest';
import { fixtureSetIdOf, loadFixtures, defaultFixturePaths, formatReport, qualifyJudge, sampleEvenly } from '../src/index.js';
import type { FixturePair } from '../src/index.js';
import { JUDGE_MIN_RECALL, JUDGE_MAX_FP, JUDGE_PROMPT_VERSION, validateJudgeConfig } from '@gnldev/durable';
import { fileURLToPath } from 'node:url';

const fx = (over: Partial<FixturePair> & Pick<FixturePair, 'id' | 'label'>): FixturePair =>
  ({ toolName: 'pay', a: 'A', b: 'B', ...over } as FixturePair);

const SET: FixturePair[] = [
  ...Array.from({ length: 10 }, (_, i) => fx({ id: `p${i}`, label: 'dup-paraphrase', a: `ayni-${i}`, b: `AYNI ${i}` })),
  ...Array.from({ length: 10 }, (_, i) => fx({ id: `n${i}`, label: 'near-miss', a: `kod-${i}`, b: `kod-${i + 50}` })),
  ...Array.from({ length: 5 }, (_, i) => fx({ id: `e${i}`, label: 'dup-exact', a: `X${i}`, b: `x${i} ` })),
  ...Array.from({ length: 5 }, (_, i) => fx({ id: `u${i}`, label: 'unrelated', a: `kirmizi-${i}`, b: `mavi-${i}` })),
];

/** A perfect judge — it reads the label from the closure, not from the prompt (test scaffolding). */
const oracle = (pairs: FixturePair[], wrong: (p: FixturePair) => boolean = () => false) =>
  async ({ user }: { system: string; user: string }) => {
    const p = pairs.find((q) => user.includes(q.a) || user.includes(q.b))!;
    const same = p.label.startsWith('dup');
    return (wrong(p) ? !same : same) ? 'SAME' : 'DIFFERENT';
  };

describe('qualification bench', () => {
  it('a perfect judge PASSES and the certificate has exactly the shape the runtime expects', async () => {
    const r = await runOn(SET, oracle(SET));
    expect(r.passed).toBe(true);
    expect(r.paraphraseRecall).toBe(1);
    expect(r.nearMissFp).toBe(0);
    // The certificate must carry EVERY field validateJudgeConfig looks for — this is the only
    // contract between bench and runtime, and a missing field would get a judge that passed the
    // exam rejected at config time.
    expect(r.cert).toMatchObject({
      v: 1, judgeModelId: 'test-model', judgePromptVersion: JUDGE_PROMPT_VERSION,
      paraphraseRecall: 1, nearMissFp: 0, passedAt: 1,
    });
    expect(r.cert!.fixtureSetId).toMatch(/^[0-9a-f]{16}$/);
    // and the runtime must actually accept it (round-trip pin)
    validateJudgeConfig({ complete: async () => 'SAME', judgeModelId: 'test-model', qualification: r.cert! });
  });

  it('labels and ids NEVER reach the judge (the exam is blind)', async () => {
    const seen: string[] = [];
    await runOn(SET, async ({ system, user }) => { seen.push(system + user); return 'DIFFERENT'; });
    const all = seen.join('\n');
    for (const p of SET) expect(all).not.toContain(p.id);
    expect(all).not.toMatch(/dup-paraphrase|near-miss|unrelated|dup-exact/);
  });

  it('a weak judge FAILS: missing most paraphrases yields no certificate, with the reason spelled out', async () => {
    const r = await runOn(SET, oracle(SET, (p) => p.label === 'dup-paraphrase'));
    expect(r.passed).toBe(false);
    expect(r.cert).toBeUndefined();
    expect(r.failureReasons.join(' ')).toContain('paraphrase recall');
    expect(r.paraphraseRecall).toBeLessThan(JUDGE_MIN_RECALL);
  });

  it('a trigger-happy judge FAILS (the question-storm bar)', async () => {
    const r = await runOn(SET, oracle(SET, (p) => p.label === 'near-miss'));
    expect(r.passed).toBe(false);
    expect(r.nearMissFp).toBeGreaterThan(JUDGE_MAX_FP);
  });

  it('silence cannot pass the exam: an unparsed answer is never credited', async () => {
    const r = await runOn(SET, async () => 'not sure, maybe they are the same');
    expect(r.unparsed).toBe(SET.length);
    expect(r.paraphraseRecall).toBe(0);
    expect(r.passed).toBe(false);

    // …and the report says WHY FIRST. Recall 0.000 is what a judge that answered wrongly every time
    // also scores, and the two need opposite fixes: one wants a different model, the other wants the
    // same model to stop narrating. Measured against a real provider: three hosted models, all three
    // unparseable (reasoning models narrate before answering), and the report led with "recall below
    // the bar" — which points at the wrong remedy.
    expect(r.failureReasons[0], 'the format diagnosis must lead').toMatch(/could not be parsed/);
    expect(r.failureReasons[0]).toMatch(/FORMAT failure, not a judgement one/);
  });

  it('a run that never reached the provider is diagnosed as TRANSPORT, not as a bad judge', async () => {
    // The gap the format diagnosis above did NOT close: `errors` and `unparsed` are separate
    // counters, and a call that throws never produces a string to fail parsing. So a run where every
    // call dies has unparsed ~0, slips past the format gate, and is reported as "recall below the
    // bar" — which tells the operator to change a model that never got asked.
    // Measured on a real provider: a model that scored 20/20 on a 20-pair sample was then run over
    // the full 600 and returned 564 errors, every one of them a rate limit. The headline read
    // "paraphrase recall 0.047 < required 0.7".
    const r = await runOn(SET, async () => { throw new Error('429 rate limit'); });
    expect(r.errors).toBe(SET.length);
    expect(r.unparsed).toBe(0); // nothing came back to be unparseable — this is why the other gate misses it
    expect(r.passed).toBe(false);
    expect(r.failureReasons[0], 'the transport diagnosis must lead').toMatch(/calls FAILED before an answer came back/);
    expect(r.failureReasons[0]).toMatch(/TRANSPORT failure/);
  });

  it('a judge that drops a FEW calls is not diagnosed as a transport failure', async () => {
    // Same half-line as the format gate, and the same reason: below it the bars still carry
    // information. Without this half the transport gate could fire on any run with one flaky call
    // and the assertion above would not notice.
    let n = 0;
    const r = await runOn(SET, async ({ user }) => {
      if (n++ < 3) throw new Error('429 rate limit');       // 3 of 30 dead
      const p = SET.find((q) => user.includes(q.a) || user.includes(q.b))!;
      return p.label.startsWith('dup') ? 'SAME' : 'DIFFERENT';
    });
    expect(r.errors).toBe(3);
    expect(r.failureReasons.join(' '), 'a minority of dead calls is not a transport verdict')
      .not.toMatch(/TRANSPORT failure/);
  });

  it('a judge that parses MOST of the time is not diagnosed as a format failure', async () => {
    // The line is half: below it the bars still carry information. A judge that fumbles a couple of
    // answers is a judgement story, not a format one, and mislabelling it would send the reader to
    // check their prompt when the model is simply wrong.
    let n = 0;
    const r = await runOn(SET, async ({ user }) => {
      n++;
      if (n <= 3) return 'hmm, hard to say';               // 3 of 30 unparseable
      const p = SET.find((q) => user.includes(q.a) || user.includes(q.b))!;
      return p.label.startsWith('dup') ? 'SAME' : 'DIFFERENT';
    });
    expect(r.unparsed).toBe(3);
    expect(r.failureReasons.join(' '), 'a minority of unparsed answers is not a format verdict')
      .not.toMatch(/could not be parsed/);
  });

  it('recall comes from paraphrases only: a judge that only recognises identical strings cannot pass', async () => {
    // A judge that gets dup-exact right and paraphrases wrong: high average, zero recall
    const r = await runOn(SET, oracle(SET, (p) => p.label === 'dup-paraphrase'));
    expect(r.byLabel['dup-exact']!.accuracy).toBe(1);
    expect(r.paraphraseRecall).toBe(0);
    expect(r.passed).toBe(false);
  });

  it('fixtureSetId is a content hash: stable under reordering, different when content changes', () => {
    const a = fixtureSetIdOf(SET);
    const b = fixtureSetIdOf([...SET].reverse());
    expect(a).toBe(b);
    const c = fixtureSetIdOf([...SET, fx({ id: 'yeni', label: 'unrelated', a: 'q', b: 'r' })]);
    expect(c).not.toBe(a);
  });

  it('the published fixtures load and are schema-checked', () => {
    const pairs = loadFixtures(defaultFixturePaths());
    expect(pairs.length).toBe(600); // two sets of 300
    expect(new Set(pairs.map((p) => p.label))).toEqual(new Set(['dup-exact', 'dup-paraphrase', 'near-miss', 'unrelated']));
  });

  it('a bar with NOTHING to measure against is a failure, not a 0.000 pass', async () => {
    // The hole this closes: both bars are RATES, and a rate over zero pairs is 0 — which prints like
    // a flawless result. Bring-your-own fixtures is a documented workflow (`--fixtures`), and a user
    // whose logs hold real duplicates naturally writes a file of nothing but duplicates. Measured on
    // that shape, a judge answering 'SAME' to every pair scored recall 1.000 / false-alarm 0.000,
    // PASSED, certificate issued — and validateJudgeConfig accepted it at runtime.
    const onlyDups = Array.from({ length: 20 }, (_, i) =>
      fx({ id: `p${i}`, label: 'dup-paraphrase', a: `ayni-${i}`, b: `AYNI ${i}` }));
    const r = await runOn(onlyDups, async () => 'SAME');
    expect(r.paraphraseRecall).toBe(1); // the measurable half really is perfect...
    expect(r.passed).toBe(false); // ...and that is still not a pass
    expect(r.cert).toBeUndefined();
    expect(r.failureReasons.join(' ')).toContain("no 'near-miss' pairs");

    // Mirror case: a set with no duplicates cannot measure recall either.
    const onlyNear = Array.from({ length: 20 }, (_, i) =>
      fx({ id: `n${i}`, label: 'near-miss', a: `kod-${i}`, b: `kod-${i + 50}` }));
    const r2 = await runOn(onlyNear, async () => 'DIFFERENT');
    expect(r2.passed).toBe(false);
    expect(r2.failureReasons.join(' ')).toContain("no 'dup-paraphrase' pairs");
  });

  it('a false-alarm bar answered by SILENCE is a failure, not a 0.007 pass', async () => {
    // The hole the two gates above do not cover: here the near-miss pairs are all PRESENT and all
    // PUT to the judge, so neither the empty-bar gate nor the thin-denominator gate fires. They just
    // never come back. Silence is scored as "no question asked" — which is faithful to runtime, and
    // which means it cannot raise a false alarm, so it settles into the denominator as clean.
    // Measured on the published 600-pair set before this gate existed: a judge that threw on 149 of
    // the 150 near-miss pairs scored that label at accuracy 0.000, reported false alarm 0.007,
    // PASSED, issued a certificate, and validateJudgeConfig accepted it. The bar the certificate
    // attests had not been exercised once.
    const r = await runOn(SET, async ({ user }) => {
      const p = SET.find((q) => user.includes(q.a) || user.includes(q.b))!;
      if (p.label === 'near-miss') throw new Error('upstream timeout');
      return p.label.startsWith('dup') ? 'SAME' : 'DIFFERENT';
    });
    expect(r.byLabel['near-miss']).toMatchObject({ n: 10, answered: 0 }); // put, never answered
    expect(r.nearMissFp).toBe(0); // the rate still reads clean — that is the trap, not the bug
    expect(r.passed).toBe(false);
    expect(r.cert).toBeUndefined();
    expect(r.failureReasons.join(' ')).toContain('0 answered pair(s) of 10 put');

    // The other side of the gate: silence that still leaves enough answers must NOT fail. A judge is
    // allowed to drop a few calls; it is not allowed to skip the whole exam. Without this half the
    // gate could reject every run with a single timeout and the assertion above would not notice.
    const flaky = (() => {
      let seen = 0;
      return async ({ user }: { system: string; user: string }) => {
        const p = SET.find((q) => user.includes(q.a) || user.includes(q.b))!;
        if (p.label === 'near-miss' && seen++ < 5) throw new Error('upstream timeout');
        return p.label.startsWith('dup') ? 'SAME' : 'DIFFERENT';
      };
    })();
    const r2 = await runOn(SET, flaky);
    expect(r2.byLabel['near-miss']).toMatchObject({ n: 10, answered: 5 });
    expect(r2.passed).toBe(true);
  });


  it('a denominator too small for the bar is a failure, not a pass', async () => {
    // The hole `--limit` opened, and the reason the empty-bar gate above did not cover it: that one
    // asks "is n zero", and one pair is not zero. Measured with a PERFECT judge at `--limit 4`
    // (one pair per label): recall 1.000, false alarm 0.000, passed=true, certificate issued — on a
    // denominator of 1. A rate over one pair carries no information about the judge, and a
    // certificate is the form in which no-information travels furthest.
    // a/b must be UNIQUE per pair: the oracle finds its pair by matching them against the prompt,
    // and fx()'s defaults are the same 'A'/'B' for everyone — with those, every lookup returns the
    // first pair and the run measures nothing. (Caught by this test failing for that reason.)
    const oneEach = ['dup-exact', 'dup-paraphrase', 'near-miss', 'unrelated'].map((label) =>
      fx({ id: label, label: label as never, a: `x-${label}`, b: `y-${label}` }));
    const r = await runOn(oneEach, oracle(oneEach));
    expect(r.paraphraseRecall).toBe(1);      // the measurable half really is perfect…
    expect(r.passed).toBe(false);            // …and it is still not a pass
    expect(r.cert).toBeUndefined();
    expect(r.failureReasons.join(' ')).toMatch(/only 1 pair/);

    // Five per label is the floor: the smallest n at which `>= 0.7` admits a passing score that is
    // not a clean sweep (4/5 = 0.8). At four it would be pass-or-nothing.
    const five = ['dup-exact', 'dup-paraphrase', 'near-miss', 'unrelated']
      .flatMap((label) => Array.from({ length: 5 }, (_, i) =>
        fx({ id: `${label}${i}`, label: label as never, a: `p-${label}-${i}`, b: `q-${label}-${i}` })));
    const ok = await runOn(five, oracle(five));
    expect(ok.passed, 'five pairs per bar is the documented floor and must pass').toBe(true);
  });

  it('the report prints each bar WITH its denominator (0.0% over 75 is not 0.0% over 2)', async () => {
    const text = formatReport(await runOn(SET, oracle(SET)));
    expect(text).toMatch(/paraphrase recall .*over 10 pairs/);
    expect(text).toMatch(/near-miss false alarm .*over 10 pairs/);
  });

  it('defaultFixturePaths survives an install path with a space in it', () => {
    // `new URL(...).pathname` hands back the PERCENT-ENCODED path, so under 'My Projects' (or any of
    // the paths macOS and Windows hand out by default) the default bench resolved to
    // `.../My%20Projects/...` and died on ENOENT against a file that was right there.
    const spaced = new URL('pairs-calibration.json', new URL('../fixtures/', 'file:///tmp/My Projects/pkg/dist/index.js'));
    expect(spaced.pathname).toContain('%20'); // the shape that broke it

    // THE ASSERTION THAT ACTUALLY HOLDS THE FIX: run the real resolver against that spaced install
    // root. The two lines above only describe Node's URL behaviour — they never call the changed
    // code, and the loop below used to resolve against THIS repository's path, which has no space
    // in it, so the whole test stayed green with the fix reverted. Measured before the base
    // parameter existed: reverting `fileURLToPath` left 10 tests green, this one among them.
    const resolved = defaultFixturePaths('file:///tmp/My Projects/pkg/dist/index.js');
    expect(resolved).toHaveLength(2);
    for (const p of resolved) {
      expect(p, 'a percent-encoded path is what ENOENT looked like').not.toMatch(/%[0-9A-Fa-f]{2}/);
      expect(p).toContain('My Projects');
    }
    // And the default call still resolves to something real.
    for (const p of defaultFixturePaths()) expect(p).not.toMatch(/%[0-9A-Fa-f]{2}/);
  });

  it('the report ALWAYS carries the synthetic-data caveat (the limit stands next to the number)', async () => {
    const r = await runOn(SET, oracle(SET));
    const text = formatReport(r);
    expect(text).toContain('synthetic');
    expect(text).toContain('precision@suspend');
    expect(r.judgePromptVersion).toBe(JUDGE_PROMPT_VERSION);
  });
});

/** Writes the fixtures to a temp file and runs the bench through the same path the CLI uses. */
async function runOn(pairs: FixturePair[], complete: (r: { system: string; user: string }) => Promise<string>) {
  const { writeFileSync, mkdtempSync } = await import('node:fs');
  const { join } = await import('node:path');
  const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'gnl-qualify-'));
  const file = join(dir, 'fx.json');
  writeFileSync(file, JSON.stringify({ v: 1, pairs }));
  return qualifyJudge({ complete, judgeModelId: 'test-model', fixtures: [file], concurrency: 2, now: 1 });
}

describe('--limit: a sampled exam is a smaller exam, not a cheaper certificate', () => {
  const mk = (label: string, i: number) =>
    ({ id: `${label}-${i}`, toolName: 't', a: `a${i}`, b: `b${i}`, label } as never);
  const full = [
    ...Array.from({ length: 10 }, (_, i) => mk('dup-exact', i)),
    ...Array.from({ length: 10 }, (_, i) => mk('dup-paraphrase', i)),
    ...Array.from({ length: 10 }, (_, i) => mk('near-miss', i)),
    ...Array.from({ length: 10 }, (_, i) => mk('unrelated', i)),
  ];

  it('samples ACROSS labels — a limit must not silently drop a whole class', () => {
    const got = sampleEvenly(full, 8);
    expect(got).toHaveLength(8);
    const counts: Record<string, number> = {};
    for (const p of got) counts[(p as { label: string }).label] = (counts[(p as { label: string }).label] ?? 0) + 1;
    // Two of each. Taking the first 8 in file order would have returned eight `dup-exact` and a
    // false-alarm rate measured against zero near-misses — a perfect score over nothing, which is
    // exactly what the empty-bar gate in this same file refuses.
    expect(counts).toEqual({ 'dup-exact': 2, 'dup-paraphrase': 2, 'near-miss': 2, unrelated: 2 });
  });

  it('a limit at or above the set size changes nothing', () => {
    expect(sampleEvenly(full, 40)).toBe(full);
    expect(sampleEvenly(full, 99)).toBe(full);
    expect(sampleEvenly(full, undefined)).toBe(full);
  });

  it('stamps a DIFFERENT fixtureSetId than the full run', () => {
    // The certificate carries the set id, so a 8-pair pass can never be read back as a 40-pair one.
    expect(fixtureSetIdOf(sampleEvenly(full, 8))).not.toBe(fixtureSetIdOf(full));
  });
});
