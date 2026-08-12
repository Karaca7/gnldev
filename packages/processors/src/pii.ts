import { recordProcessorReport } from '@gnldev/durable';
import type { Processor, ProcessorCtx, ProcessorInput, ProcessorOutput, ProcessorToolResult } from '@gnldev/durable';
import { redactString, redactMessages, PII_PATTERNS, ORDER, type PiiType } from './redact.js';

export interface PiiRedactorOptions {
  /** Which PII types to mask (default: all). */
  types?: PiiType[];
  /** Mask generator (default: `[REDACTED_<TYPE>]`). */
  mask?: (type: PiiType) => string;
  /** input/output/both (default: 'both'). */
  on?: 'input' | 'output' | 'both';
  /**
   * Also redact the tool execute result (processToolResult hook) — default: false.
   * known limitation: tool output (external API/DB/file result) was being written to the journal as
   * PLAIN TEXT; it may contain PII. Left as opt-in so existing piiRedactor users' behavior does NOT
   * CHANGE — this option only masks tool output when explicitly set to `true`.
   */
  redactToolResults?: boolean;
}

const DEFAULT_TYPES: PiiType[] = ['email', 'phone', 'creditCard', 'ssn', 'ip'];

/**
 * For the audit report (`recordProcessorReport`): follows the SAME order/regexes as `redactString`
 * to count how many matches were masked — does not change the transformation ITSELF (redactString/
 * redactMessages remain the single source of truth), it only derives "how many + which type" info.
 * Order MATTERS: after a type is masked, the text is updated so later (broader) patterns don't
 * re-count the already-masked portion (same behavior as `redactString` itself).
 */
function countRedactions(text: string, types: PiiType[], mask: (t: PiiType) => string): { total: number; types: PiiType[] } {
  let out = text;
  const hitTypes: PiiType[] = [];
  let total = 0;
  for (const t of ORDER) {
    if (!types.includes(t)) continue;
    const re = PII_PATTERNS[t];
    const g = new RegExp(re.source, re.flags);
    const matches = out.match(g);
    const n = matches ? matches.length : 0;
    if (n > 0) { hitTypes.push(t); total += n; }
    out = out.replace(g, mask(t));
  }
  return { total, types: hitTypes };
}

/** Aggregates redactions across ALL text fields of a ProcessorInput/ProcessorOutput (system/prompt/messages
 *  are counted separately — same granularity as redactMessages, which redacts each message/part INDEPENDENTLY). */
function countInputRedactions(
  fields: { system?: unknown; prompt?: unknown; messages?: any[] },
  types: PiiType[],
  mask: (t: PiiType) => string,
): { total: number; types: PiiType[] } {
  let total = 0;
  const typeSet = new Set<PiiType>();
  const add = (r: { total: number; types: PiiType[] }) => { total += r.total; for (const t of r.types) typeSet.add(t); };
  if (typeof fields.system === 'string') add(countRedactions(fields.system, types, mask));
  if (typeof fields.prompt === 'string') add(countRedactions(fields.prompt, types, mask));
  for (const m of fields.messages ?? []) {
    if (typeof m?.content === 'string') add(countRedactions(m.content, types, mask));
    else if (Array.isArray(m?.content)) {
      for (const part of m.content) if (typeof part?.text === 'string') add(countRedactions(part.text, types, mask));
    }
  }
  return { total, types: [...typeSet] };
}

/**
 * PII redaction processor — pure regex (email/phone/credit-card/ssn/ip). Deterministic, so no
 * journaling is needed: produces the same masking on resume. The input side runs BEFORE persistInput
 * → masked content is written to the journal, the model NEVER sees raw PII.
 *
 * HONEST WARNING (naive regex matching): These regexes are best-effort, they do NOT provide an
 * AUDIT/COMPLIANCE-grade (GDPR/HIPAA/PCI-DSS etc.) PII DETECTION GUARANTEE. Known limits: only
 * matches specific formats (e.g. US/generic-format phone numbers, plain 16-digit card numbers) —
 * international/local formats, unstructured PII like name/address, or unusual formatting (line
 * breaks, different separators) can slip through; it can also produce false positives (e.g. a
 * random 16-digit number). Use it as a noise-reduction / first-line-of-defense layer, not as a real
 * compliance/security boundary.
 */
export function piiRedactor(opts: PiiRedactorOptions = {}): Processor {
  const types = opts.types ?? DEFAULT_TYPES;
  const mask = opts.mask ?? ((t: PiiType) => `[REDACTED_${t.toUpperCase()}]`);
  const on = opts.on ?? 'both';

  const proc: Processor = { name: 'pii-redactor' };

  if (on === 'input' || on === 'both') {
    // NOT async (behavior must stay the same — callers may call processInput synchronously and
    // read the returned object directly). The audit report (recordProcessorReport) is BEST-EFFORT +
    // fire-and-forget: it does NOT CHANGE the transform/synchronous-return contract, it's only an
    // EXTRA record.
    proc.processInput = (input: ProcessorInput, ctx: ProcessorCtx) => {
      const out: ProcessorInput = {
        system: typeof input.system === 'string' ? redactString(input.system, types, mask) : input.system,
        prompt: typeof input.prompt === 'string' ? redactString(input.prompt, types, mask) : input.prompt,
        messages: input.messages ? redactMessages(input.messages, types, mask) : input.messages,
      };
      const { total, types: hitTypes } = countInputRedactions(input, types, mask);
      if (total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'input', { redactedCount: total, types: hitTypes });
      return out;
    };
  }

  if (on === 'output' || on === 'both') {
    proc.processOutput = (output: ProcessorOutput, ctx: ProcessorCtx) => {
      const out: ProcessorOutput = {
        ...output,
        text: typeof output.text === 'string' ? redactString(output.text, types, mask) : output.text,
        messages: output.messages ? redactMessages(output.messages, types, mask) : output.messages,
      };
      const { total, types: hitTypes } = countInputRedactions(
        { prompt: output.text, messages: output.messages }, types, mask,
      );
      if (total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'output', { redactedCount: total, types: hitTypes });
      return out;
    };
  }

  // AUDIT TASK: opt-in hook so tool output doesn't write plain PII to the journal. String output is
  // redacted directly; object output is redacted via the JSON.stringify → redact → JSON.parse chain —
  // if stringify/parse fails (circular structure or JSON broken by redaction), the original output is
  // NOT TOUCHED (same "deterministic, pure transform only" principle as processInput/processOutput;
  // the raw value still gets written to the journal, but at least the framework doesn't silently
  // corrupt data).
  if (opts.redactToolResults) {
    // durable-tool.ts ALWAYS awaits THIS HOOK (`await proc.processToolResult(...)`) →
    // making it async doesn't break the existing contract (existing tests already await it too).
    proc.processToolResult = async (res: ProcessorToolResult, ctx: ProcessorCtx) => {
      const { output } = res;
      const report = (r: { total: number; types: PiiType[] }) => {
        if (r.total > 0) void recordProcessorReport(ctx, 'pii-redactor', 'tool', { redactedCount: r.total, types: r.types });
      };
      if (typeof output === 'string') {
        report(countRedactions(output, types, mask));
        return { output: redactString(output, types, mask) };
      }
      if (output !== null && typeof output === 'object') {
        let json: string;
        try {
          json = JSON.stringify(output);
        } catch {
          return { output }; // circular structure etc. → cannot serialize, NOT TOUCHED
        }
        const redacted = redactString(json, types, mask);
        try {
          const parsed = JSON.parse(redacted);
          report(countRedactions(json, types, mask));
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
