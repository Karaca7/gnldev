// SEMANTIC v2 — the rule ladder. What this file pins is MEASUREMENT, not intuition: every case
// below comes from the measurement tables of a calibration bench kept outside this repository.
// 1) THE CONSTITUTION: two classes only — normalizers may equate, separators may only drop. The
//    caller-dictionary class the panel designed was removed after measurement (see the pin below)
// 2) ANTI-CASE: there is no open-ended prefix rule — Berg ⊄ Bergman, Pro ⊄ ProHeat, both measured
//    on the fresh set where a prefix rule that worked on the calibration set produced false alarms
// 3) Separators only DROP (the fail-open direction); normalizers are the only class that can equate
// 4) Decimal guard: '1.5' never collapses into '15' (the reason the ladder is opt-in, H4)
import { describe, it, expect } from 'vitest';
import { runRuleLadder, rulesConfigOf, DEFAULT_RULES, RULE_CLASS, charNorm, squash, tokenize } from '../src/semantic-rules.js';
import type { SemanticRulesConfig, RuleId } from '../src/semantic-rules.js';

const D = rulesConfigOf(true)!;
const one = (a: string, b: string, cfg: SemanticRulesConfig = D) => runRuleLadder(['v'], { v: a }, { v: b }, cfg);

describe('rule ladder — normalizers (the ONLY class that may conclude "same")', () => {
  it('digit VALUE: a leading zero is noise, a neighbouring number is signal', () => {
    expect(one('inv-2026-0142', 'inv 2026 142').kind).toBe('match');
    expect(one('tv-42', 'tv-43').kind).toBe('separate'); // 42 is never 43
  });

  it('order-preserving digit concatenation; an AMBIGUOUS split stays gray', () => {
    expect(one('inv202600142', 'inv-2026-00142').kind).toBe('match');
    // '26' against '2026' is genuinely ambiguous (a shortened year, or a different number entirely)
    expect(one('inv-26-0142', 'inv-2026-0142').kind).toBe('gray');
  });

  it('character folding: dropped Turkish characters, punctuation and spacing', () => {
    expect(one('danışmanlık a.ş.', 'danismanlik as').kind).toBe('match');
    expect(one('philips airfryer', 'philips air fryer').kind).toBe('match');
    expect(one('arc-bzd-nf', 'arc-bzdnf').kind).toBe('match');
  });

  it('digit concatenation is NARROW: it joins a split block, it does not merge separate number slots', () => {
    // Measured gap: 'lot 1 box 23' and 'lot 12 box 3' both flatten to '123'. Two different lots, and
    // the decimal guard cannot see this shape (the separator is a space), so the rule itself narrows:
    // one side must carry a single block for a join to be meaningful.
    expect(one('lot 1 box 23', 'lot 12 box 3').kind).not.toBe('match');
    expect(one('inv202600142', 'inv-2026-00142').kind).toBe('match'); // the real split/join case survives
  });

  it('DECIMAL GUARD: 1.5 never merges with 15 (neither by concatenation nor by squashing)', () => {
    expect(one('fiyat 1.5 kg', 'fiyat 15 kg').kind).not.toBe('match');
    expect(one('1,5 lt', '15 lt').kind).not.toBe('match');
  });
});

describe('rule ladder — separators (they may only DROP)', () => {
  it('size ladder: XL is not XXL (the highest-scoring false alarm measured, cos=0.970)', () => {
    const r = one('phi-af-xxl / trabzon depo', 'phi-af-xl / trabzon depo');
    expect(r.kind).toBe('separate');
    expect(r.trace.map((t) => t.rule)).toContain('size-ladder');
  });

  it('short-code edit-1: abc is not abd, mu is not nu', () => {
    expect(one('abc-42', 'abd-42').kind).toBe('separate');
    expect(one('selin yildiz - mu danismanlik', 'selin yildiz - nu danismanlik').kind).toBe('separate');
  });

  it('the gazetteer ships EMPTY — without a list, clashing names do NOT separate (locale portability)', () => {
    expect(DEFAULT_RULES.gazetteers).toEqual([]);
    expect(one('ahmet yilmaz', 'mehmet yilmaz').kind).toBe('gray'); // no list, no verdict
    const withList = rulesConfigOf({ gazetteers: [['ahmet', 'mehmet', 'selin']] })!;
    expect(one('ahmet yilmaz', 'mehmet yilmaz', withList).kind).toBe('separate');
  });

  it('a gap in the gazetteer never INVENTS an equality: one side listed → gray', () => {
    const withList = rulesConfigOf({ gazetteers: [['ahmet']] })!;
    expect(one('ahmet yilmaz', 'sevval yilmaz', withList).kind).toBe('gray');
  });
});

describe('rule ladder — what the classes may conclude', () => {
  it('at type level: only two classes exist, and each is tagged', () => {
    expect(RULE_CLASS['digit-value']).toBe('normalizer');
    expect(RULE_CLASS['punct-space']).toBe('normalizer');
    expect(RULE_CLASS['size-ladder']).toBe('separator');
    expect(RULE_CLASS['shortcode-edit1']).toBe('separator');
  });

  it('the caller-supplied DICTIONARY class is gone, and the reason is pinned', () => {
    // It was capped at 'gray' by the safety constitution — the same value the fallthrough returns —
    // so it could not change a single outcome while still asking for upkeep. Measured: every ladder
    // decision on both sets came from the list-free rules. Anything that reintroduces a dictionary
    // has to answer this test first.
    const withDictionaries = { synonyms: [['depo', 'ambar']], localeTokens: { eylul: '09' }, initials: true } as unknown as SemanticRulesConfig;
    const plain = one('dys-v15 / gaziantep depo', 'dys-v15 / gaziantep ambar');
    const fancy = one('dys-v15 / gaziantep depo', 'dys-v15 / gaziantep ambar', rulesConfigOf(withDictionaries)!);
    expect(fancy.kind).toBe(plain.kind); // identical outcome — that was the whole problem
    expect(fancy.trace.some((x) => ['synonym', 'locale-token', 'initials'].includes(x.rule as string))).toBe(false);
  });

  it('a gazetteer still separates when supplied (the escape hatch works)', () => {
    const withList = rulesConfigOf({ gazetteers: [['ahmet', 'mehmet']] })!;
    expect(one('ahmet yilmaz', 'mehmet yilmaz', withList).kind).toBe('separate');
    expect(one('ahmet yilmaz', 'mehmet yilmaz').kind).toBe('gray'); // default: left to the judge
  });
});

describe('rule ladder — ANTI-CASES (rules that backfired on the fresh set)', () => {
  it('there is NO open-ended prefix rule: Berg ⊄ Bergman, Pro ⊄ ProHeat', () => {
    // EK-3: these two pairs are genuinely different work. A prefix rule that looked good on the
    // calibration set produced false alarms on the fresh one, so it was never adopted — it is not
    // disabled here, it does not exist.
    expect(one('lukas bergman - nordvik', 'lukas berg - nordvik').kind).toBe('gray');
    expect(one('bissell hali yikama pro', 'bissell hali yikama proheat').kind).toBe('gray');
  });

  it('there is NO phonetic-skeleton rule: an abbreviation alone never equates two records', () => {
    expect(one('samsung 42 inc tv', 'smsng tv42').kind).not.toBe('match');
  });
});

describe('rule ladder — combination and opt-outs', () => {
  it('multi-field: one separator drops the pair; all-equal matches; the rest is gray', () => {
    const keys = ['sku', 'depo'];
    const sep = runRuleLadder(keys, { sku: 'tv-42', depo: 'izmir' }, { sku: 'tv-43', depo: 'izmir' }, D);
    expect(sep.kind).toBe('separate');
    const m = runRuleLadder(keys, { sku: 'tv-42', depo: 'izmir' }, { sku: 'tv 42', depo: 'İzmir' }, D);
    expect(m.kind).toBe('match');
    const g = runRuleLadder(keys, { sku: 'tv-42', depo: 'izmir' }, { sku: 'tv 42', depo: 'ambar 3' }, D);
    expect(g.kind).toBe('gray');
  });

  it('even after a separator fires, EVERY field is traced (the operator\'s only window)', () => {
    const r = runRuleLadder(['a', 'b'], { a: 'tv-42', b: 'x-xl' }, { a: 'tv-43', b: 'x-xxl' }, D);
    expect(r.kind).toBe('separate');
    expect(new Set(r.trace.map((t) => t.field))).toEqual(new Set(['a', 'b']));
  });

  it('disable: switching a rule off changes the verdict, and the opt-out stays visible as data', () => {
    const off = rulesConfigOf({ disable: ['size-ladder'] })!;
    expect(one('x-xxl', 'x-xl', off).kind).not.toBe('separate');
    expect(off.disable).toEqual(['size-ladder']);
  });

  it('pure function: same input, same output, no side effects (the replay guarantee)', () => {
    const a = one('inv-2026-0142', 'inv 2026 142');
    const b = one('inv-2026-0142', 'inv 2026 142');
    expect(a).toEqual(b);
  });
});

describe('rule ladder — helpers', () => {
  it('tokenize splits on the letter/digit boundary; charNorm and squash behave as documented', () => {
    expect(tokenize('TV42-Pro')).toEqual(['tv', '42', 'pro']);
    expect(charNorm('Danışmanlık A.Ş.')).toBe('danismanlik a s');
    expect(squash('Air Fryer XXL')).toBe('airfryerxxl');
  });
});
