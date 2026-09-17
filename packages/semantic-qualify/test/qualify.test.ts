// THE QUALIFICATION BENCH — what this file pins:
// 1) The exam is BLIND: no label, id or filename reaches the judge, and the order is shuffled
//    deterministically (so the shuffle itself cannot vary between runs)
// 2) Scoring reads the SAME exported constants the runtime enforces — one contract, not two copies
// 3) An unparsed answer is never credited: silence cannot pass an exam
// 4) Recall is measured on PARAPHRASE pairs only, so credit for dup-exact cannot carry a weak judge
// 5) fixtureSetId is a content hash: reordering keeps it, changing content changes it
import { describe, it, expect } from 'vitest';
import { fixtureSetIdOf, loadFixtures, defaultFixturePaths, formatReport, qualifyJudge } from '../src/index.js';
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
