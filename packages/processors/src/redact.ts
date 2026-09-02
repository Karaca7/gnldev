// PII regexes + message/string redaction helpers. Pure (deterministic) → no journaling needed.
//
// HONEST WARNING (naive regex matching): These patterns are best-effort — they do NOT provide a real
// PII DETECTION/compliance (GDPR/HIPAA/PCI-DSS) guarantee, they can be easily missed (unusual format,
// International format, unstructured PII like name/address) or produce false positives. Use as a
// Noise-reduction / first-line-of-defense layer, do NOT RELY on it as the SOLE mechanism for critical
// Compliance decisions.

export type PiiType = 'email' | 'phone' | 'creditCard' | 'ssn' | 'ip' | 'iban';

export const PII_PATTERNS: Record<PiiType, RegExp> = {
  email: /[\w.+-]+@[\w-]+\.[\w.-]+/g,
  // 16-digit card (grouped with spaces/dashes): 4-4-4-4
  creditCard: /\b\d{4}[ -]?\d{4}[ -]?\d{4}[ -]?\d{4}\b/g,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  ip: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  // E.g. +90 555 123 4567 / (212) 555-1234 / 0532 111 22 33 / 5551234567.
  //
  // Structural on purpose. The previous form (`\+?\d[\d\s().-]{7,}\d`) counted CHARACTERS, and its
  // Class held spaces and dashes, so three digits spread over a wide span cleared the bar: measured,
  // It masked `2024-01-15 10` out of a timestamp, the whole of `1.2.3 - 4.5.6`, a run id, and two
  // Digits separated by eight spaces. Error messages and logs carry timestamps, so that is text
  // Corruption in the payload this most often sees.
  //
  // Digit GROUPS are bounded instead, separators must be single characters, and an ISO date cannot
  // Start a match; `looksLikePhone` then rules on the digits.
  //
  // Measured against 24 written forms across a dozen countries, and against non-PII text that must
  // Survive. An earlier version of this pattern was checked against eleven formats CHOSEN AFTER the
  // Rule was written, all of them shapes it already accepted — it passed, while `+49 30 12345678`,
  // `+90 5321112233`, `0212 5551234` and `(212) 5551234` went through unmasked, and adding one space
  // To `+905321112233` was enough to turn its masking off. A set assembled to fit the rule measures
  // The rule against itself; the list in `builtins.test.ts` is now deliberately wider than the rule.
  //
  // The refusal is safe here only because `replaceValidated` does not consume a rejected span — see
  // Its note. With `String.replace`, a candidate that spanned `1234567890 555-123-4567`, failed the
  // Digit count and was skipped took the real number with it.
  phone: /(?!\d{4}-\d{2}-\d{2})(?<![\d(\w])\(?\+?\d{1,4}\)?(?:[ .-]?\(?\d{1,4}\)?){0,6}(?![\w])/g,
  // Country + check digits + up to 30 alphanumerics, printed either compact or in 4-char groups.
  iban: /\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]{4}){2,7}(?:[ -]?[A-Z0-9]{1,3})?\b/g,
};

/**
 * The self-check some identifiers carry: a digit computed from the others.
 *
 * It is what separates a card number from any sixteen digits — measured, the pattern alone masked
 * `1234 5678 9012 3456` and `order 1234567812345678` as cards, which is text corruption rather than
 * Privacy. Where a validator exists the answer is arithmetic, not a guess, so the precision it buys
 * Costs nothing in certainty. Types with no entry here (email, ip, phone, ssn) have nothing to check
 * Against and are matched on shape alone, exactly as before.
 */
export const PII_VALIDATORS: Partial<Record<PiiType, (match: string) => boolean>> = {
  creditCard: luhn,
  iban: ibanMod97,
  phone: looksLikePhone,
};

/**
 * No checksum exists for a phone number, so this is a shape rule rather than a proof: 7–15 digits
 * (E.164's ceiling), and once a number is split at all, its parts are short — an area code or a
 * Block, never an eight-digit run.
 *
 * It is what stops the digit-hungry cases the pattern alone still reaches: a 16-digit order number
 * And a `20240115 093012` run id both clear the pattern, and both are text this has no business
 * Touching. Safe to REFUSE a match here, unlike on a loose candidate, because the pattern is already
 * Structurally narrow — measured on `log 1234-56-78 555-123-4567`, the refused span does not extend
 * Over the neighbouring phone number, so nothing is swallowed and released.
 */
export function looksLikePhone(s: string): boolean {
  const groups = s.match(/\d+/g) ?? [];
  const digits = groups.reduce((n, g) => n + g.length, 0);
  if (digits < 7 || digits > 15) return false;
  if (/\s{2,}/.test(s)) return false; // a run of spaces joins two unrelated numbers, not a number
  // Only the LAST group may be long: what precedes a subscriber number is a country or area code,
  // Which is short. An earlier rule required EVERY group to be short, which is how the most common
  // Written forms in several countries stopped being masked — `+49 30 12345678`, `+90 5321112233`,
  // `0212 5551234`, `(212) 5551234` all leaked, and adding one space to `+905321112233` was enough to
  // Turn its masking off. Measured against 24 real formats rather than a set chosen to fit the rule.
  return groups.slice(0, -1).every((g) => g.length <= 4);
}

/** Card check digit (Luhn). Rejects runs too short to be a card so a stray 12-digit id cannot pass. */
export function luhn(s: string): boolean {
  const d = s.replace(/\D/g, '');
  if (d.length < 12 || d.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = d.length - 1; i >= 0; i--) {
    let n = Number(d[i]);
    if (alt) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/**
 * IBAN check (ISO 13616 mod-97): move the first four characters to the end, map letters to numbers,
 * The remainder against 97 must be 1. Computed digit by digit because the value is far wider than a
 * JS number can hold exactly — `Number(...) % 97` on a 30-digit string is silently wrong.
 */
export function ibanMod97(s: string): boolean {
  const v = s.replace(/[\s-]/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return false;
  const rearranged = v.slice(4) + v.slice(0, 4);
  let rem = 0;
  for (const ch of rearranged) {
    const code = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of code) rem = (rem * 10 + Number(digit)) % 97;
  }
  return rem === 1;
}

// Apply creditCard/ssn/ip BEFORE phone (the phone pattern can also catch them).
// EXPORT: used by pii.ts's audit report (recordProcessorReport) to derive the redaction COUNT in the
// Same order — shares the same application order WITHOUT CHANGING redactString's behavior.
// `iban` leads: it is the longest and most specific shape here, and leaving it until after the
// Digit-hungry patterns would hand them its account number first.
export const ORDER: PiiType[] = ['iban', 'email', 'creditCard', 'ssn', 'ip', 'phone'];

/**
 * A caller-supplied pattern, for the identifiers the five built-ins cannot name.
 *
 * The built-in list is US-shaped — `ssn` exists nowhere else — so a deployment that has to mask a
 * National id, an IBAN, a patient record number or an internal customer id has no built-in that
 * Matches it. Before this existed the only options were to drop a built-in type (which removes
 * Coverage rather than adding it) or to mutate the shared `PII_PATTERNS` object process-wide.
 *
 * Carries its own replacement rather than going through the `mask` callback, so adding a custom
 * Pattern does not widen `mask`'s parameter from `PiiType` to `string` — which would break every
 * Existing `(t: PiiType) => string` callback under `strictFunctionTypes`.
 */
export interface PiiPattern {
  /** Used in the default mask and in the audit report, e.g. 'iban' → `[REDACTED_IBAN]`. */
  name: string;
  /** Matched against the text. A missing `g` flag is added rather than silently matching once. */
  pattern: RegExp;
  /** Replacement text. Defaults to `[REDACTED_<NAME>]`. */
  mask?: string;
  /**
   * Runs on each match; returning false leaves the text alone. This is where a national id's own
   * Checksum goes, and it exists so a caller-supplied pattern has the same power the built-ins do —
   * `creditCard` and `iban` are validated by `PII_VALIDATORS`, and shipping that for ourselves while
   * Handing callers a bare regex would be the asymmetry, not a simplification.
   */
  test?: (match: string) => boolean;
}

/** `g` is what makes `String.replace` replace every occurrence; without it only the first is masked. */
export function globalize(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
}

/**
 * Replaces every match that passes `test`, and — the point of writing this by hand rather than using
 * `String.replace` with a callback — does NOT consume the ones that fail.
 *
 * A rejected match is a span the scanner looked at and declined, not a span it has dealt with.
 * `String.replace` advances past it regardless, so a candidate that swallowed a real identifier and
 * Then failed its own checksum took that identifier out of reach of every later pattern. Measured,
 * With the checksum enabled and by default:
 *
 *   `ref 1111 2222 4111 1111 1111 1111`  → the valid card inside came back unmasked
 *   `id 1234567890 555-123-4567`         → nothing at all was masked
 *
 * Both are the failure mode a validator is supposed to prevent, caused by the validator. Resuming at
 * `index + 1` costs a rescan of the rejected span and removes the class: whatever real identifier
 * Starts inside it is still found. Everything else about the scan is unchanged — matches that pass
 * Are replaced exactly as before, and a pattern with no `test` behaves identically to `replace`.
 */
export function replaceValidated(
  s: string,
  re: RegExp,
  replacement: string,
  test?: (match: string) => boolean,
): { text: string; count: number } {
  const g = globalize(re);
  let out = '';
  let last = 0;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = g.exec(s)) !== null) {
    if (m[0] === '') { g.lastIndex++; continue; } // a zero-width match would spin forever
    if (test && !test(m[0])) { g.lastIndex = m.index + 1; continue; }
    out += s.slice(last, m.index) + replacement;
    last = m.index + m[0].length;
    count++;
  }
  return { text: out + s.slice(last), count };
}

export const patternMask = (p: PiiPattern): string => p.mask ?? `[REDACTED_${p.name.toUpperCase()}]`;

export interface RedactOptions {
  extra?: PiiPattern[];
  /** Run the checksums in `PII_VALIDATORS` and each pattern's own `test`. Default: true. */
  validate?: boolean;
}

/**
 * The ONE place patterns are applied. `redactString` reads the text off it and the audit report reads
 * the counts, so the two cannot describe different redactions — they used to be separate walks over
 * the same text, which is precisely how a report starts claiming a masking that never ran.
 */
export function applyRedactions(
  s: string,
  types: PiiType[],
  mask: (t: PiiType) => string,
  opts: RedactOptions = {},
): { text: string; total: number; types: string[] } {
  const extra = opts.extra ?? [];
  const validate = opts.validate !== false;
  let out = s;
  let total = 0;
  const hit: string[] = [];

  const step = (name: string, re: RegExp, replacement: string, test?: (m: string) => boolean) => {
    const { text, count } = replaceValidated(out, re, replacement, validate ? test : undefined);
    out = text;
    if (count > 0) { hit.push(name); total += count; }
  };

  // Custom patterns run FIRST, and that order is load-bearing rather than cosmetic: the built-in
  // `phone` is greedy enough to swallow a national id or an ISO date (measured), so a caller-supplied
  // Pattern that ran after it would find its text already masked — under the wrong name.
  for (const p of extra) step(p.name, p.pattern, patternMask(p), p.test);
  // iban first, then creditCard/ssn/ip BEFORE phone (the phone pattern can also catch them).
  for (const t of ORDER) {
    if (!types.includes(t)) continue;
    step(t, PII_PATTERNS[t], mask(t), PII_VALIDATORS[t]);
  }
  return { text: out, total, types: hit };
}

export function redactString(
  s: string,
  types: PiiType[],
  mask: (t: PiiType) => string,
  extra: PiiPattern[] = [],
  validate = true,
): string {
  return applyRedactions(s, types, mask, { extra, validate }).text;
}

/** Redacts a message list (string or parts-array content); returns a copy. */
export function redactMessages(
  messages: any[],
  types: PiiType[],
  mask: (t: PiiType) => string,
  extra: PiiPattern[] = [],
  validate = true,
): any[] {
  return messages.map((m) => {
    if (typeof m?.content === 'string') {
      return { ...m, content: redactString(m.content, types, mask, extra, validate) };
    }
    if (Array.isArray(m?.content)) {
      return {
        ...m,
        content: m.content.map((part: any) =>
          typeof part?.text === 'string' ? { ...part, text: redactString(part.text, types, mask, extra, validate) } : part,
        ),
      };
    }
    return m;
  });
}
