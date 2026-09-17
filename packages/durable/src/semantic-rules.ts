// FAZ-7 (semantik v2) — the RULE LADDER: the deterministic half of the judge-verified candidate arm.
//
// WHY THIS EXISTS, and why it is shaped the way it is: a calibration bench kept outside this repository measured that cosine alone cannot separate "same job, written
// differently" from "different job that merely looks alike" — at every threshold, recall and false
// alarms move together. What DID separate them was structure: comparing numbers by VALUE, and
// knowing that XL and XXL are two rungs of one ladder. This module is that structure, and nothing
// more probabilistic than that.
//
// THE CONSTITUTION (from the design panel's H3, encoded in the types, not just the prose):
//
//   normalizer  → may return 'match'    — needs NO world knowledge (character folding, digit value)
//   separator   → may return 'separate' — closed sets; only ever DROPS a candidate
//
// The panel's ruling had a THIRD class here, fed by caller-supplied dictionaries, capped at "defer
// to the next rung". It was removed after measurement, and the reason generalises: that cap is the
// value the fallthrough already returns, so the class could not change a single outcome while still
// asking for upkeep. The attribution run settled it — on both calibration sets EVERY ladder decision
// came from the list-free rules (shortcode-edit1, punct-space, digit-value) and the seven-entry
// default size ladder; the dictionary surface decided nothing. (Deviation recorded in the
// semantic-v2 panel record, which is kept on file and is not part of this repository.)
//
// What survives the cut is the same safety argument: a rule may only conclude "same" when no world
// knowledge is involved. Open-ended prefix matching and phonetic skeletons are NOT IN THIS FILE AT
// ALL — not disabled, absent. The fresh-set run measured a prefix rule matching 'Berg' to 'Bergman'
// and 'Pro' to 'ProHeat': two different people, two different products.
//
// Direction of failure: 'separate' drops a candidate, which means no question gets asked, which is
// today's behavior — the safe side. 'match' asks a human. Nothing here ever executes or skips work.
//
// This module is PURE: no journal, no closures, no async, no I/O. It is the part of the chain that
// can be reasoned about by reading it, replayed identically forever, and unit-tested without a
// provider. Keep it that way (an import of './journal.js' here is a design regression).

/** Bumped when rule SEMANTICS change — stamped into judge verdict records so a verdict produced
 *  under an older ladder is never served after the ladder itself changed its mind. */
export const SEM_RULESET_VERSION = '1';

export type RuleClass = 'normalizer' | 'separator';
export type RuleDir = 'match' | 'separate' | 'gray';

export type RuleId =
  // normalizer → match | gray
  | 'punct-space' | 'digit-value' | 'digit-concat'
  // separator → separate | gray
  | 'size-ladder' | 'shortcode-edit1' | 'gazetteer';

export const RULE_CLASS: Record<RuleId, RuleClass> = {
  'punct-space': 'normalizer',
  'digit-value': 'normalizer',
  'digit-concat': 'normalizer',
  'size-ladder': 'separator',
  'shortcode-edit1': 'separator',
  'gazetteer': 'separator',
};

/** One rule's contribution to one field's outcome — the operator's "why" (goes into the incident). */
export interface RuleTrace {
  rule: RuleId;
  cls: RuleClass;
  field: string;
  dir: RuleDir;
}

export interface SemanticRulesConfig {
  /**
   * Closed-set separators. Two values whose tokens land on DIFFERENT rungs of the same ladder are
   * different work. Default: one locale-neutral clothing/appliance size ladder. A rung that is a
   * single letter ('s', 'm', 'l') can also appear as an initial or a legal-suffix fragment; the
   * consequence is a dropped candidate (an unasked question), never a wrong question.
   */
  sizeLadders?: string[][];
  /**
   * ESCAPE HATCH, not a recommended practice — read the measurement before using it.
   *
   * Lists of values that are mutually exclusive within their group. Both sides in the SAME list and
   * different → separate; a gap in the list can never invent an equality, so the failure direction
   * is safe. Default EMPTY, and it stays empty in every measurement we published.
   *
   * WHY IT IS DEMOTED: on both calibration sets the ladder's entire measured effect came from the
   * list-free rules; this one contributed nothing because it was empty and nothing was lost. Worse,
   * WITHOUT a judge configured it changes no user-visible outcome at all (a 'separate' and a 'gray'
   * both mean "no question"), so its only real effect is cutting judge calls. Weigh that against a
   * list that decays silently — a name list is never finished, and a stale one protects less every
   * month without saying so. If your closed set is genuinely small and stable (twelve warehouses,
   * not "Turkish surnames") and you run a judge, this saves calls. Otherwise leave it alone: the
   * judge already knows Ahmet is not Mehmet, and it needs no upkeep.
   */
  gazetteers?: string[][];
  /** Tokens of at most this length differing by exactly one substitution are different codes
   *  ('abc'/'abd', 'mu'/'nu'). Default 4; 0 disables. A NUMBER, not a list — nothing to maintain. */
  shortCodeMaxLen?: number;
  /** Rule ids to switch off. The caller journals this list alongside the ladder's verdict, so a
   *  disabled rule is a visible decision rather than a silent hole. */
  disable?: RuleId[];
}

export const DEFAULT_RULES: SemanticRulesConfig = {
  sizeLadders: [['xs', 's', 'm', 'l', 'xl', 'xxl', 'xxxl']],
  gazetteers: [],
  shortCodeMaxLen: 4,
};

export type LadderOutcome =
  /** Every declared field is normalizer-equal → deterministic duplicate question. */
  | { kind: 'match'; trace: RuleTrace[] }
  /** At least one field carries a separator conflict → candidate drops (today's behavior). */
  | { kind: 'separate'; trace: RuleTrace[] }
  /** The residue the deterministic half cannot settle → the judge's input (or nothing, if no judge). */
  | { kind: 'gray'; trace: RuleTrace[] };

// ── character/token plumbing (normalizer class — no world knowledge) ──────────────────────────

/**
 * Character-level normalization: Unicode diacritic folding + punctuation/separator collapse.
 *
 * Scope note, because the name undersells it: this is where 'Danışmanlık' and 'Danismanlik' become
 * one string. Dotless 'ı' has no combining-mark decomposition, so it is mapped explicitly; that
 * single mapping is the one place this function makes a script-level choice, and it is deliberate —
 * dropped Turkish characters were the single most common paraphrase shape in the measured set.
 * The risk it accepts is the same one case-folding already accepts (two identifiers differing only
 * by 'ı'/'i' are treated as one); disable via `disable: ['punct-space']` where identifiers are
 * case- and diacritic-significant.
 */
export function charNorm(v: string): string {
  return v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // combining marks: ş→s, ü→u, and İ (which NFD splits into i + dot)
    .replace(/ı/g, 'i') // dotless ı has no decomposition — the one explicit script choice
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Splits on the letter/digit boundary too, so 'tv42' and 'tv 42' tokenize identically. */
export function tokenize(v: string): string[] {
  return charNorm(v).match(/\p{L}+|\p{N}+/gu) ?? [];
}

/**
 * Separator-free form: 'Air Fryer' and 'Airfryer', 'A.Ş.' and 'AŞ', 'ARC-BZD-NF' and 'ARC-BZDNF'
 * become one string. Word boundaries carry no identity in an SKU or a legal suffix, and where they
 * differ they differ by typing habit — the measured set is full of exactly this shape.
 *
 * Guarded by the same decimal rule as digit-concat: squashing '1.5 kg' would produce '15kg' and
 * quietly equate two different amounts, so a digit-separator-digit value opts out of this
 * comparison entirely (see `evaluateField`).
 */
export function squash(v: string): string {
  return charNorm(v).replace(/\s+/g, '');
}

const hasDecimal = (v: string): boolean => /\p{N}[.,]\p{N}/u.test(v);

const isDigits = (t: string): boolean => /^\p{N}+$/u.test(t);
/** Leading zeros stripped as STRING — '3190002026000078' exceeds Number's exact range, and a
 *  precision-lost comparison would silently equate two different invoice numbers. */
const digitVal = (t: string): string => t.replace(/^0+(?=\p{N})/u, '');

function seqEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Same token sequence, digits compared by VALUE: '0142' equals '142', '42' does not equal '43'. */
function digitValueEqual(ta: string[], tb: string[]): boolean {
  if (ta.length !== tb.length) return false;
  for (let i = 0; i < ta.length; i++) {
    const x = ta[i]!, y = tb[i]!;
    if (isDigits(x) && isDigits(y)) {
      if (digitVal(x) !== digitVal(y)) return false;
    } else if (x !== y) return false;
  }
  return true;
}

/**
 * Order-preserving digit concatenation: 'INV202600142' equals 'INV-2026-00142' because the letters
 * match in order and the digits, joined, are the same string.
 *
 * DECIMAL GUARD: a value containing a digit-separator-digit pattern ('1.5', '1,5') is excluded on
 * both sides. Without it this rule collapses '1.5' and '15' into one job — the exact surprise that
 * made the whole ladder opt-in (heyet H4). The raw values are inspected here, before charNorm eats
 * the separator.
 */
function digitConcatEqual(ta: string[], tb: string[], rawA: string, rawB: string): boolean {
  if (hasDecimal(rawA) || hasDecimal(rawB)) return false;
  const alphaA = ta.filter((t) => !isDigits(t));
  const alphaB = tb.filter((t) => !isDigits(t));
  if (!seqEqual(alphaA, alphaB)) return false;
  // Joined RAW, not value-stripped: inside a concatenation the zeros are load-bearing characters
  // ('2026' + '00142' is '202600142', not '2026142'). Per-token value comparison is digit-value's
  // job, one rung above.
  const digA = ta.filter(isDigits);
  const digB = tb.filter(isDigits);
  // NARROWED to the split/join case: ONE side must carry a single block. Without this, 'lot 1 box 23'
  // and 'lot 12 box 3' both concatenate to '123' and the rule declares two different lots identical —
  // the decimal guard cannot see that shape because the separator is a space. Joining is only
  // meaningful when one side wrote as one block what the other split up.
  if (digA.length !== 1 && digB.length !== 1) return false;
  if (digA.length === digB.length) return false; // same slot count → compare per slot (digit-value's job)
  const dA = digA.join('');
  const dB = digB.join('');
  return dA.length > 0 && dA === dB;
}

/** Tokens unique to each side (multiset difference) — the residue the separator/knowledge rules see. */
function residue(ta: string[], tb: string[]): [string[], string[]] {
  const a = [...ta], b = [...tb];
  for (const t of [...a]) {
    const j = b.indexOf(t);
    if (j >= 0) { a.splice(a.indexOf(t), 1); b.splice(j, 1); }
  }
  return [a, b];
}

function groupConflict(a: string[], b: string[], groups: string[][]): boolean {
  for (const group of groups) {
    const set = new Set(group.map(charNorm));
    const ga = a.filter((t) => set.has(t));
    const gb = b.filter((t) => set.has(t));
    // Both sides name a member of the same closed group, and they are not the same member.
    if (ga.length > 0 && gb.length > 0 && !seqEqual(ga, gb)) return true;
  }
  return false;
}

function shortCodeEdit1(a: string[], b: string[], maxLen: number): boolean {
  if (maxLen <= 0) return false;
  for (const x of a) {
    for (const y of b) {
      if (x.length !== y.length || x.length > maxLen) continue;
      let diff = 0;
      for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) diff++;
      if (diff === 1) return true;
    }
  }
  return false;
}

// ── the ladder ────────────────────────────────────────────────────────────────────────────────

interface FieldOutcome { dir: RuleDir; traces: RuleTrace[] }

function evaluateField(field: string, rawA: string, rawB: string, cfg: SemanticRulesConfig, off: Set<RuleId>): FieldOutcome {
  const traces: RuleTrace[] = [];
  const t = (rule: RuleId, dir: RuleDir): RuleTrace => ({ rule, cls: RULE_CLASS[rule], field, dir });

  if (rawA === rawB) return { dir: 'match', traces };

  // NORMALIZERS — the only class allowed to conclude "same".
  const decimalSafe = !hasDecimal(rawA) && !hasDecimal(rawB);
  if (!off.has('punct-space')) {
    if (charNorm(rawA) === charNorm(rawB)) return { dir: 'match', traces: [t('punct-space', 'match')] };
    if (decimalSafe && squash(rawA) === squash(rawB)) return { dir: 'match', traces: [t('punct-space', 'match')] };
  }

  const ta = tokenize(rawA), tb = tokenize(rawB);
  // SAME DECIMAL GUARD as squash and digit-concat, and it belongs here for the same reason: tokenizing
  // splits '1.05' into ['1','05'], and stripping the leading zero PER TOKEN turns it into ['1','5'] —
  // so '1.05' and '1.5' compare equal and two different amounts become one job. Leading zeros are
  // only meaningless to the LEFT of a decimal point; this rule cannot see the point, so it steps aside.
  if (!off.has('digit-value') && decimalSafe && digitValueEqual(ta, tb)) return { dir: 'match', traces: [t('digit-value', 'match')] };
  if (!off.has('digit-concat') && digitConcatEqual(ta, tb, rawA, rawB)) return { dir: 'match', traces: [t('digit-concat', 'match')] };

  // SEPARATORS — may only drop. Evaluated on the residue so shared context ('/ Trabzon Depo')
  // cannot mask a conflicting rung.
  const [ra, rb] = residue(ta, tb);
  if (!off.has('size-ladder') && groupConflict(ra, rb, cfg.sizeLadders ?? DEFAULT_RULES.sizeLadders!)) {
    return { dir: 'separate', traces: [t('size-ladder', 'separate')] };
  }
  if (!off.has('gazetteer') && groupConflict(ra, rb, cfg.gazetteers ?? [])) {
    return { dir: 'separate', traces: [t('gazetteer', 'separate')] };
  }
  if (!off.has('shortcode-edit1') && shortCodeEdit1(ra, rb, cfg.shortCodeMaxLen ?? DEFAULT_RULES.shortCodeMaxLen!)) {
    return { dir: 'separate', traces: [t('shortcode-edit1', 'separate')] };
  }

  // Everything the algorithms could settle has been tried. What is left needs world knowledge —
  // "is Ahmet the same person as Mehmet", "is a depot a warehouse" — and that is the judge's job,
  // because the judge brings that knowledge with it and needs no upkeep.
  //
  // A caller-supplied dictionary class used to sit here (synonyms, locale tokens, initials). It was
  // REMOVED, and the reason is worth keeping: capped at 'gray' by the safety constitution, it could
  // only ever return the value the fallthrough already returns, so it changed no outcome at all —
  // pure ceremony with a maintenance bill attached. Measured on both calibration sets, every single
  // ladder decision came from the list-free rules (shortcode-edit1, punct-space, digit-value) and
  // the 7-entry default size ladder; the dictionary surface contributed zero.
  return { dir: 'gray', traces };
}

/**
 * Field-by-field, then combined: ANY separator conflict → separate; ALL fields normalizer-equal →
 * match; anything else → gray.
 *
 * Every field is evaluated even after a conflict is found, because the trace is the operator's only
 * window into why a candidate went the way it did — a partial trace answers "it was dropped" but not
 * "by what".
 */
export function runRuleLadder(
  keys: string[],
  prior: Record<string, string>,
  incoming: Record<string, string>,
  cfg: SemanticRulesConfig,
): LadderOutcome {
  const off = new Set(cfg.disable ?? []);
  const trace: RuleTrace[] = [];
  let separate = false;
  let allMatch = true;
  for (const k of keys) {
    const o = evaluateField(k, prior[k] ?? '', incoming[k] ?? '', cfg, off);
    trace.push(...o.traces);
    if (o.dir === 'separate') separate = true;
    if (o.dir !== 'match') allMatch = false;
  }
  if (separate) return { kind: 'separate', trace };
  return allMatch ? { kind: 'match', trace } : { kind: 'gray', trace };
}

/** Resolves the `rules` field of the semantic config into a usable ruleset (`true` → defaults). */
export function rulesConfigOf(rules: true | SemanticRulesConfig | undefined): SemanticRulesConfig | undefined {
  if (rules === undefined) return undefined;
  if (rules === true) return DEFAULT_RULES;
  return { ...DEFAULT_RULES, ...rules };
}
