// @gnldev/processors built-ins: piiRedactor (5 PII types), moderation tripwire, toolFilter.
import { describe, it, expect } from 'vitest';
import { piiRedactor, piiTextRedactor } from '../src/pii.js';
import { moderationProcessor } from '../src/moderation.js';
import { toolFilter } from '../src/tool-filter.js';
import { ProcessorTripwire } from '@gnldev/durable';

const ctx = { runId: 'r', journal: {} as any, step: async (_n: string, c: any) => c() };

describe('piiRedactor', () => {
  it('masks all 5 PII types (email/phone/cc/ssn/ip)', () => {
    const p = piiRedactor();
    const out = p.processInput!(
      { prompt: 'mail a@b.com phone +90 555 123 4567 card 4111 1111 1111 1111 ssn 123-45-6789 ip 10.0.0.1' },
      ctx,
    ) as any;
    const text = out.prompt as string;
    expect(text).not.toContain('a@b.com');
    expect(text).not.toContain('4111');
    expect(text).toContain('[REDACTED_EMAIL]');
    expect(text).toContain('[REDACTED_CREDITCARD]');
    expect(text).toContain('[REDACTED_SSN]');
    expect(text).toContain('[REDACTED_IP]');
    expect(text).toContain('[REDACTED_PHONE]');
  });

  // A Processor only ever sees processInput/processOutput/processToolResult. Text that reaches an
  // Exporter by another route — a run's failure message, written by recordRunOutcome — needs the same
  // Mask and had no way to reuse it, because the default type list is private to this module.
  it('piiTextRedactor masks the same things as the processor, for text no processor sees', () => {
    const redact = piiTextRedactor();
    const out = redact('refused: "a@b.com" from 10.0.0.1');
    expect(out).not.toContain('a@b.com');
    expect(out).not.toContain('10.0.0.1');
    expect(out).toContain('[REDACTED_EMAIL]');
    expect(out).toContain('[REDACTED_IP]');
    // The surrounding reason survives — masking must not cost the operator the message.
    expect(out).toContain('refused');
  });

  it('piiTextRedactor honours types/mask, and shares piiRedactor\'s defaults', () => {
    const only = piiTextRedactor({ types: ['email'], mask: () => '<gone>' });
    expect(only('a@b.com at 10.0.0.1')).toBe('<gone> at 10.0.0.1');
    // Default list is the processor's: an IP is masked without being asked for.
    expect(piiTextRedactor()('10.0.0.1')).toBe('[REDACTED_IP]');
  });

  // An identifier that carries its own check digit can be recognised by arithmetic rather than by
  // Shape, so the built-in for it has no false positives to trade against.
  it('iban is masked when mod-97 holds, and left alone when it does not', () => {
    const redact = piiTextRedactor();
    expect(redact('hesap TR330006100519786457841326 kapandi')).toBe('hesap [REDACTED_IBAN] kapandi');
    expect(redact('DE89370400440532013000 gonderildi')).toBe('[REDACTED_IBAN] gonderildi');
    // One digit changed: not an IBAN, and nothing else may claim it either.
    expect(redact('hesap TR330006100519786457841327 kapandi')).toBe('hesap TR330006100519786457841327 kapandi');
    // Printed in the usual four-character groups.
    expect(redact('TR33 0006 1005 1978 6457 8413 26')).toBe('[REDACTED_IBAN]');
  });

  // The point of the checksum: a card is separated from any sixteen digits. Before this, an order
  // Number was masked as a card and the operator lost it for nothing.
  it('a card passes Luhn; an order number of the same shape stays readable', () => {
    const redact = piiTextRedactor();
    expect(redact('kart 4111 1111 1111 1111 reddedildi')).toBe('kart [REDACTED_CREDITCARD] reddedildi');
    expect(redact('siparis 1234567812345678 gonderildi')).toBe('siparis 1234567812345678 gonderildi');
  });

  it('validate:false goes back to masking on shape alone', () => {
    const blunt = piiTextRedactor({ validate: false });
    expect(blunt('siparis 1234567812345678 gonderildi')).toBe('siparis [REDACTED_CREDITCARD] gonderildi');
  });

  // The phone pattern used to count characters, not digits, so a timestamp cleared its bar. Error
  // Messages and logs carry timestamps, which is the payload this most often runs over.
  it('phone no longer eats timestamps, version ranges or run ids', () => {
    const redact = piiTextRedactor();
    for (const text of [
      'failed at 2024-01-15 10:30 during step',
      'versions 1.2.3 - 4.5.6 differ',
      'run 20240115 093012 aborted',
      'codes 1        2 seen',
    ]) expect(redact(text), text).toBe(text);
  });

  it('...while every real phone format still masks', () => {
    const redact = piiTextRedactor();
    for (const [text, want] of [
      ['call +90 555 123 4567 now', 'call [REDACTED_PHONE] now'],
      ['call 555-123-4567 now', 'call [REDACTED_PHONE] now'],
      ['call (212) 555-1234 now', 'call [REDACTED_PHONE] now'],
      ['call 5551234567 now', 'call [REDACTED_PHONE] now'],
      ['ara 0532 111 22 33 x', 'ara [REDACTED_PHONE] x'],
      ['call +442071838750 now', 'call [REDACTED_PHONE] now'],
    ]) expect(redact(text), text).toBe(want);
  });

  // Why the tightness lives in the PATTERN and not in a validator that refuses loose matches: a
  // Greedy candidate swallows the whole span, the refusal comes too late to give it back, and a real
  // Phone number is left in the clear. Over-matching is only safe while every match is masked.
  it('a phone next to a date-like run is still masked, not swallowed and released', () => {
    const out = piiTextRedactor()('log 1234-56-78 555-123-4567 bitti');
    expect(out).not.toContain('555-123-4567');
  });

  // The five original built-ins are US-shaped — `ssn` exists nowhere else — so a deployment with a
  // National id or an internal customer number had nothing that named its own data.
  it('extraPatterns masks an identifier no built-in type can name', () => {
    // A patient record number: no built-in shape comes close, and there is no country whose id list
    // Could reasonably be shipped here — which is the whole reason this option exists.
    const redact = piiTextRedactor({ extraPatterns: [{ name: 'mrn', pattern: /\bMRN-\d{6}\b/g }] });
    const out = redact('dosya MRN-482100 goruldu');
    expect(out).toContain('[REDACTED_MRN]');
    expect(out).not.toContain('482100');
  });

  // Order is load-bearing, not cosmetic: the built-in `phone` pattern is greedy enough to swallow an
  // 11-digit national id, so a custom pattern running after it would find its text already masked —
  // Under the wrong name, which also makes the audit report describe the wrong type.
  it('a custom pattern wins over a greedy built-in, instead of arriving after it', () => {
    const withCustom = piiTextRedactor({ extraPatterns: [{ name: 'tckn', pattern: /\b\d{11}\b/g }] });
    expect(withCustom('musteri 12345678901 kaydi')).toContain('[REDACTED_TCKN]');
    // Without it, the same text is masked by `phone` — the mislabel this ordering avoids.
    expect(piiTextRedactor()('musteri 12345678901 kaydi')).toContain('[REDACTED_PHONE]');
  });

  it('a pattern missing the g flag still masks every occurrence, not just the first', () => {
    const redact = piiTextRedactor({ extraPatterns: [{ name: 'mrn', pattern: /MRN-\d{4}/ }] });
    const out = redact('MRN-1111 and MRN-2222');
    expect(out).toBe('[REDACTED_MRN] and [REDACTED_MRN]');
  });

  it('a custom mask overrides the generated one', () => {
    const redact = piiTextRedactor({ extraPatterns: [{ name: 'mrn', pattern: /MRN-\d{4}/g, mask: '***' }] });
    expect(redact('see MRN-1111')).toBe('see ***');
  });

  // This used to be a silent no-op: the text came back untouched and nothing was reported, so a
  // Deployment could believe a type was covered while the value went through in the clear.
  it('an unknown type name is refused at construction, not ignored', () => {
    expect(() => piiTextRedactor({ types: ['tckn' as any] })).toThrow(/unknown PII type/);
    expect(() => piiRedactor({ types: ['tckn' as any] })).toThrow(/mask nothing/);
    // A malformed custom pattern is refused on the same principle, at the same time.
    expect(() => piiTextRedactor({ extraPatterns: [{ name: 'x', pattern: 'nope' as any }] })).toThrow(/RegExp/);
  });

  it('also masks text inside message parts-array content', () => {
    const p = piiRedactor();
    const out = p.processInput!(
      { messages: [{ role: 'user', content: [{ type: 'text', text: 'mail a@b.com' }] }] },
      ctx,
    ) as any;
    expect(out.messages[0].content[0].text).toBe('mail [REDACTED_EMAIL]');
  });

  it('when redactToolResults is off (default), processToolResult is not defined — tool output is untouched', () => {
    const p = piiRedactor();
    expect(p.processToolResult).toBeUndefined();
  });

  it('redactToolResults: true — masks a string tool output', async () => {
    const p = piiRedactor({ redactToolResults: true });
    const res = await p.processToolResult!(
      { toolName: 't', toolCallId: 'c1', input: {}, output: 'mail a@b.com' },
      ctx,
    );
    expect(res.output).toBe('mail [REDACTED_EMAIL]');
  });

  it('redactToolResults: true — masks an object tool output via JSON.stringify→redact→parse', async () => {
    const p = piiRedactor({ redactToolResults: true });
    const res = await p.processToolResult!(
      { toolName: 't', toolCallId: 'c2', input: {}, output: { email: 'a@b.com', note: 'ok' } },
      ctx,
    );
    expect(res.output).toEqual({ email: '[REDACTED_EMAIL]', note: 'ok' });
  });

  it('redactToolResults: true — circular structure cannot be serialized, original output is untouched', async () => {
    const p = piiRedactor({ redactToolResults: true });
    const circular: any = { a: 1 };
    circular.self = circular;
    const res = await p.processToolResult!(
      { toolName: 't', toolCallId: 'c3', input: {}, output: circular },
      ctx,
    );
    expect(res.output).toBe(circular);
  });

  it('redactToolResults: true — does not touch number/null output', async () => {
    const p = piiRedactor({ redactToolResults: true });
    expect((await p.processToolResult!({ toolName: 't', toolCallId: 'c4', input: {}, output: 42 }, ctx)).output).toBe(42);
    expect((await p.processToolResult!({ toolName: 't', toolCallId: 'c5', input: {}, output: null }, ctx)).output).toBe(null);
  });
});

describe('moderationProcessor', () => {
  it('throws ProcessorTripwire on a blocked term', () => {
    const p = moderationProcessor({ blocklist: ['secret'] });
    expect(() => p.processInput!({ prompt: 'this is SECRET data' }, ctx as any)).toThrow(ProcessorTripwire);
  });

  it('passes on clean input', () => {
    const p = moderationProcessor({ blocklist: ['secret'] });
    expect(p.processInput!({ prompt: 'hello world' }, ctx as any)).toBeTruthy();
  });
});

describe('toolFilter', () => {
  it('hides the denied tool; applies the allow whitelist', () => {
    const tools = { a: 1, b: 2, c: 3 } as any;
    expect(Object.keys(toolFilter({ deny: ['b'] }).processTools!(tools, ctx as any))).toEqual(['a', 'c']);
    expect(Object.keys(toolFilter({ allow: ['a'] }).processTools!(tools, ctx as any))).toEqual(['a']);
  });
});
