import { recordProcessorReport } from '@gnldev/durable';
import type { Processor, ProcessorCtx, ProcessorInput, ProcessorOutput, ProcessorToolResult } from '@gnldev/durable';
import {
  redactString, redactMessages, applyRedactions, PII_PATTERNS,
  type PiiType, type PiiPattern,
} from './redact.js';

export interface PiiRedactorOptions {
  /** Which PII types to mask (default: all). */
  types?: PiiType[];
  /** Mask generator (default: `[REDACTED_<TYPE>]`). */
  mask?: (type: PiiType) => string;
  /** input/output/both (default: 'both'). */
  on?: 'input' | 'output' | 'both';
  /**
   * Also redact the tool execute result (processToolResult hook) — default: false.
   * Known limitation: tool output (external API/DB/file result) was being written to the journal as
   * PLAIN TEXT; it may contain PII. Left as opt-in so existing piiRedactor users' behavior does NOT
   * CHANGE — this option only masks tool output when explicitly set to `true`.
   */
  redactToolResults?: boolean;
  /**
   * Extra patterns, for the identifiers the five built-in types cannot name.
   *
   * The built-in list is US-shaped (`ssn` exists nowhere else), so a national id, an IBAN, a patient
   * Record number or an internal customer id has no type that matches it. Dropping a built-in from
   * `types` removes coverage rather than adding any, and mutating the exported `PII_PATTERNS` changes
   * Behavior for every redactor in the process — neither is a way to add your own.
   *
   * These run BEFORE the built-ins, deliberately: the built-in `phone` pattern is greedy enough to
   * Swallow a national id (measured — `12345678901` comes back `[REDACTED_PHONE]`), so a pattern that
   * Ran afterwards would find its text already masked under the wrong name.
   *
   *   piiRedactor({ extraPatterns: [{ name: 'iban', pattern: /TR\d{24}/g }] })
   */
  extraPatterns?: PiiPattern[];
  /**
   * Run each identifier's own checksum before masking — Luhn for `creditCard`, mod-97 for `iban`,
   * And any `test` on a custom pattern. Default: true.
   *
   * It is what separates a card number from any sixteen digits: measured, the pattern alone masked
   * `order 1234567812345678` as a card, which loses the order number without protecting anything.
   * The trade is real and worth stating — a card typed with a wrong digit fails Luhn and is then left
   * Alone. Set to `false` to mask on shape only, which is the older, blunter behavior: it corrupts
   * More text but cannot be talked out of masking anything.
   */
  validate?: boolean;
}

const DEFAULT_TYPES: PiiType[] = ['email', 'phone', 'creditCard', 'ssn', 'ip', 'iban'];

/**
 * Rejects a configuration that would mask less than the caller thinks it does.
 *
 * A name with no built-in behind it used to be dropped in silence — `types: ['iban']` returned the
 * Text untouched and reported nothing, so a deployment could believe a type was covered while the
 * Value went through in the clear. TypeScript catches it only for TS callers passing a literal;
 * Config read from JS, JSON or an env var reaches here unchecked. Both entry points run this at
 * CONSTRUCTION — config time, not per-run — so a mistake surfaces at startup instead of inside a
 * Run that has already touched the data.
 */
function assertUsablePatterns(types: PiiType[], extra: PiiPattern[]): void {
  const unknown = types.filter((t) => !(t in PII_PATTERNS));
  if (unknown.length) {
    throw new Error(
      `piiRedactor: unknown PII type(s) ${unknown.map((u) => JSON.stringify(u)).join(', ')} — these would mask nothing. ` +
      `Built-in types are ${Object.keys(PII_PATTERNS).join(', ')}; anything else goes in extraPatterns.`,
    );
  }
  for (const p of extra) {
    if (!p?.name || !(p.pattern instanceof RegExp)) {
      throw new Error(`piiRedactor: extraPatterns entries need a non-empty \`name\` and a RegExp \`pattern\` (got ${JSON.stringify(p)}).`);
    }
  }
}

/**
 * The same masking as `piiRedactor`, as a plain string function, for the text that never passes
 * Through a processor at all.
 *
 * A `Processor` only sees `processInput`/`processOutput`/`processToolResult`. A run's failure
 * Message is written from `recordRunOutcome` in @gnldev/durable, which no processor is consulted
 * About, and it is not always the host's own text: a provider that refuses a request commonly
 * Echoes the offending input back inside the message. Anything that ships that message onward —
 * `@gnldev/otel`'s span attributes are the case this was added for — needs the same mask, and had
 * No way to reuse it because `DEFAULT_TYPES` is private to this module.
 *
 * Shares that constant and the default mask with `piiRedactor` deliberately: two copies of the
 * Defaults is exactly how the redacted path and the un-redacted one drift apart.
 *
 *   import { piiTextRedactor } from '@gnldev/processors';
 *   await exportRun(journal, runId, { endpoint, redact: piiTextRedactor() });
 */
export function piiTextRedactor(
  opts: Pick<PiiRedactorOptions, 'types' | 'mask' | 'extraPatterns' | 'validate'> = {},
): (text: string) => string {
  const types = opts.types ?? DEFAULT_TYPES;
  const mask = opts.mask ?? ((t: PiiType) => `[REDACTED_${t.toUpperCase()}]`);
  const extra = opts.extraPatterns ?? [];
  const validate = opts.validate !== false;
  assertUsablePatterns(types, extra);
  return (text: string) => (typeof text === 'string' ? redactString(text, types, mask, extra, validate) : text);
}

/**
 * For the audit report (`recordProcessorReport`): the counts come off the SAME call that performs the
 * Redaction (`applyRedactions`), so the report cannot describe a masking that did not run. It used to
 * Be a second, independent walk over the same text with the same order copied by hand — which is
 * Exactly how the two drift once a validator or a new pattern lands in only one of them.
 */
function countRedactions(
  text: string,
  types: PiiType[],
  mask: (t: PiiType) => string,
  extra: PiiPattern[] = [],
  validate = true,
): { total: number; types: string[] } {
  const { total, types: hitTypes } = applyRedactions(text, types, mask, { extra, validate });
  return { total, types: hitTypes };
}

/** Aggregates redactions across ALL text fields of a ProcessorInput/ProcessorOutput (system/prompt/messages
 *  Are counted separately — same granularity as redactMessages, which redacts each message/part INDEPENDENTLY). */
function countInputRedactions(
  fields: { system?: unknown; prompt?: unknown; messages?: any[] },
  types: PiiType[],
  mask: (t: PiiType) => string,
  extra: PiiPattern[] = [],
  validate = true,
): { total: number; types: string[] } {
  let total = 0;
  const typeSet = new Set<string>();
  const add = (r: { total: number; types: string[] }) => { total += r.total; for (const t of r.types) typeSet.add(t); };
  if (typeof fields.system === 'string') add(countRedactions(fields.system, types, mask, extra, validate));
  if (typeof fields.prompt === 'string') add(countRedactions(fields.prompt, types, mask, extra, validate));
  for (const m of fields.messages ?? []) {
    if (typeof m?.content === 'string') add(countRedactions(m.content, types, mask, extra, validate));
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) if (typeof part?.text === 'string') add(countRedactions(part.text, types, mask, extra, validate));
    }
  }
  return { total, types: [...typeSet] };
}

/**
 * PII redaction processor — pure regex (email/phone/credit-card/ssn/ip). Deterministic, so no
 * Journaling is needed: produces the same masking on resume. The input side runs BEFORE persistInput
 * → masked content is written to the journal, the model NEVER sees raw PII.
 *
 * HONEST WARNING (naive regex matching): These regexes are best-effort, they do NOT provide an
 * AUDIT/COMPLIANCE-grade (GDPR/HIPAA/PCI-DSS etc.) PII DETECTION GUARANTEE. Known limits: only
 * Matches specific formats (e.g. US/generic-format phone numbers, plain 16-digit card numbers) —
 * International/local formats, unstructured PII like name/address, or unusual formatting (line
 * Breaks, different separators) can slip through; it can also produce false positives (e.g. a
 * Random 16-digit number). Use it as a noise-reduction / first-line-of-defense layer, not as a real
 * Compliance/security boundary.
 *
 * SCOPE, measured — WHAT THE OUTPUT SIDE DOES NOT COVER: `processOutput` transforms the
 * `{text, messages}` view, so `result.text` and `result.response.messages` come back masked on both
 * `runDurable` and `streamDurable`, and so does persisted thread memory. `result.steps` and
 * `result.content` DO NOT — they still hold the model's raw output, and a caller reading either one
 * sees unredacted PII. This is not fixable inside the hook: a processor's output arity is
 * unconstrained (a summariser legally returns one message for a turn that produced three), so no
 * mapping back onto per-step records exists, and `content` is a parts array rather than messages.
 * Read `text`/`response.messages`; treat `steps`/`content` as raw. On the STREAM path the
 * `textStream`/`fullStream` deltas are raw as well — they reach the client before the turn ends, so
 * use `on: 'input'` (or `runDurable`) if the wire itself must never carry it.
 */
export function piiRedactor(opts: PiiRedactorOptions = {}): Processor {
  const types = opts.types ?? DEFAULT_TYPES;
  const mask = opts.mask ?? ((t: PiiType) => `[REDACTED_${t.toUpperCase()}]`);
  const extra = opts.extraPatterns ?? [];
  const validate = opts.validate !== false;
  assertUsablePatterns(types, extra);
  const on = opts.on ?? 'both';

  const proc: Processor = { name: 'pii-redactor' };

  if (on === 'input' || on === 'both') {
    // NOT async (behavior must stay the same — callers may call processInput synchronously and
    // Read the returned object directly). The audit report (recordProcessorReport) is BEST-EFFORT +
    // Fire-and-forget: it does NOT CHANGE the transform/synchronous-return contract, it's only an
    // EXTRA record.
    proc.processInput = (input: ProcessorInput, ctx: ProcessorCtx) => {
      const out: ProcessorInput = {
        system: typeof input.system === 'string' ? redactString(input.system, types, mask, extra, validate) : input.system,
        prompt: typeof input.prompt === 'string' ? redactString(input.prompt, types, mask, extra, validate) : input.prompt,
        messages: input.messages ? redactMessages(input.messages, types, mask, extra, validate) : input.messages,
      };
      const { total, types: hitTypes } = countInputRedactions(input, types, mask, extra, validate);
      if (total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'input', { redactedCount: total, types: hitTypes });
      return out;
    };
  }

  if (on === 'output' || on === 'both') {
    proc.processOutput = (output: ProcessorOutput, ctx: ProcessorCtx) => {
      const out: ProcessorOutput = {
        ...output,
        text: typeof output.text === 'string' ? redactString(output.text, types, mask, extra, validate) : output.text,
        messages: output.messages ? redactMessages(output.messages, types, mask, extra, validate) : output.messages,
      };
      const { total, types: hitTypes } = countInputRedactions(
        { prompt: output.text, messages: output.messages }, types, mask, extra, validate,
      );
      if (total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'output', { redactedCount: total, types: hitTypes });
      return out;
    };
  }

  // AUDIT TASK: opt-in hook so tool output doesn't write plain PII to the journal. String output is
  // Redacted directly; object output is redacted via the JSON.stringify → redact → JSON.parse chain —
  // If stringify/parse fails (circular structure or JSON broken by redaction), the original output is
  // NOT TOUCHED (same "deterministic, pure transform only" principle as processInput/processOutput;
  // The raw value still gets written to the journal, but at least the framework doesn't silently
  // Corrupt data).
  if (opts.redactToolResults) {
    // Durable-tool.ts ALWAYS awaits THIS HOOK (`await proc.processToolResult(...)`) →
    // Making it async doesn't break the existing contract (existing tests already await it too).
    proc.processToolResult = async (res: ProcessorToolResult, ctx: ProcessorCtx) => {
      const { output } = res;
      // `string[]`, not `PiiType[]`: a custom pattern's name belongs in the audit report too, or the
      // Report would say fewer types were hit than the redaction actually masked.
      const report = (r: { total: number; types: string[] }) => {
        if (r.total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'tool', { redactedCount: r.total, types: r.types });
      };
      if (typeof output === 'string') {
        report(countRedactions(output, types, mask, extra, validate));
        return { output: redactString(output, types, mask, extra, validate) };
      }
      if (output !== null && typeof output === 'object') {
        let json: string;
        try {
          json = JSON.stringify(output);
        } catch {
          return { output }; // circular structure etc. → cannot serialize, NOT TOUCHED
        }
        const redacted = redactString(json, types, mask, extra, validate);
        try {
          const parsed = JSON.parse(redacted);
          report(countRedactions(json, types, mask, extra, validate));
          return { output: parsed };
        } catch {
          return { output }; // redaction broke the JSON → original returned UNTOUCHED
        }
      }
      return { output }; // number/boolean/null/undefined → cannot contain PII
    };
  }

  return proc;
}
