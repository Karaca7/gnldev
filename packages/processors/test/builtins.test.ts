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
  // exporter by another route — a run's failure message, written by recordRunOutcome — needs the same
  // mask and had no way to reuse it, because the default type list is private to this module.
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
  // shape, so the built-in for it has no false positives to trade against.
  it('iban is masked when mod-97 holds, and left alone when it does not', () => {
    const redact = piiTextRedactor();
    expect(redact('account TR330006100519786457841326 closed')).toBe('account [REDACTED_IBAN] closed');
    expect(redact('DE89370400440532013000 sent')).toBe('[REDACTED_IBAN] sent');
    // One digit changed: not an IBAN, and nothing else may claim it either.
    expect(redact('account TR330006100519786457841327 closed')).toBe('account TR330006100519786457841327 closed');
    // Printed in the usual four-character groups.
    expect(redact('TR33 0006 1005 1978 6457 8413 26')).toBe('[REDACTED_IBAN]');
  });

  // `iban` leads ORDER for a reason, and the reason was not pinned: with it last, the digit-hungry
  // patterns reach an IBAN first and it comes back `TR[REDACTED_PHONE]` — country prefix stranded,
  // wrong name in the audit report.
  it('iban is matched before the digit-hungry patterns can claim it', () => {
    const redact = piiTextRedactor();
    const out = redact('account NO9386011117947 closed');
    expect(out).toBe('account [REDACTED_IBAN] closed');
    // A short IBAN is the case that exposes it — a 26-character TR one is too long for `phone`.
    expect(out).not.toContain('NO');
  });

  // The point of the checksum: a card is separated from any sixteen digits. Before this, an order
  // number was masked as a card and the operator lost it for nothing.
  it('a card passes Luhn; an order number of the same shape stays readable', () => {
    const redact = piiTextRedactor();
    expect(redact('kart 4111 1111 1111 1111 reddedildi')).toBe('kart [REDACTED_CREDITCARD] reddedildi');
    expect(redact('order 1234567812345678 sent')).toBe('order 1234567812345678 sent');
  });

  it('validate:false goes back to masking on shape alone', () => {
    const blunt = piiTextRedactor({ validate: false });
    expect(blunt('order 1234567812345678 sent')).toBe('order [REDACTED_CREDITCARD] sent');
  });

  // The phone pattern used to count characters, not digits, so a timestamp cleared its bar. Error
  // messages and logs carry timestamps, which is the payload this most often runs over.
  it('phone no longer eats timestamps, version ranges or run ids', () => {
    const redact = piiTextRedactor();
    for (const text of [
      'failed at 2024-01-15 10:30 during step',
      'versions 1.2.3 - 4.5.6 differ',
      'run 20240115 093012 aborted',
      'codes 1        2 seen',
    ]) expect(redact(text), text).toBe(text);
  });

  // The list is deliberately wider than the rule that has to satisfy it. An earlier version of this
  // test held six formats, all of them shapes the rule already accepted, and it passed while
  // `+49 30 12345678`, `+90 5321112233`, `0212 5551234` and `(212) 5551234` were silently going
  // through unmasked — a set chosen to fit the rule measures the rule against itself.
  it('...while every real phone format still masks', () => {
    const redact = piiTextRedactor();
    for (const text of [
      '+90 555 123 4567', '555-123-4567', '(212) 555-1234', '5551234567', '0532 111 22 33',
      '555.123.4567', '+442071838750', '+1 (212) 555-1234', '+90(532)111 22 33',
      // Short prefix + one long block: the most common written form in several countries, and the
      // group of formats a "every group must be short" rule dropped.
      '+49 30 12345678', '+90 5321112233', '+90 532 1112233', '0212 5551234', '(212) 5551234',
      '+90(532)1112233',
      // Many short groups — the mirror case, where a small cap on group COUNT truncated the match.
      '+33 1 23 45 67 89', '+886 2 2345 6789', '+81 3 1234 5678', '00 90 532 111 22 33',
      '+1-800-555-0199', '212 555 1234', '+7 495 123-45-67', '+34 612 34 56 78', '0090 532 111 2233',
    ]) expect(redact(`ara ${text} lutfen`), text).toBe('ara [REDACTED_PHONE] lutfen');
  });

  // A rejected match is a span the scanner declined, not one it has dealt with. `String.replace`
  // advances past it either way, so a candidate that swallowed a real identifier and then failed its
  // own checksum took that identifier out of reach of every later pattern — the exact failure a
  // validator exists to prevent, caused by the validator. `replaceValidated` resumes at index+1.
  //
  // An earlier version of this test made the general claim from ONE example, which happened to be
  // saved by the ISO-date lookahead rather than by anything structural. These are the cases that
  // were actually leaking.
  it('a rejected candidate does not take a real identifier down with it', () => {
    const redact = piiTextRedactor();
    for (const [text, mustNotContain] of [
      // The candidate spans both numbers, fails the digit-count rule, and used to consume the phone.
      ['id 1234567890 555-123-4567 bitti', '555-123-4567'],
      ['ref 20240115093012 555-123-4567 son', '555-123-4567'],
      ['log 1234-56-78 555-123-4567 bitti', '555-123-4567'],
      // Same shape with a checksum: the card window starts one group early, Luhn refuses it, and the
      // genuine card inside came back in the clear.
      ['ref 1111 2222 4111 1111 1111 1111 son', '4111 1111 1111 1111'],
    ]) expect(redact(text), text).not.toContain(mustNotContain);
  });

  // The five original built-ins are US-shaped — `ssn` exists nowhere else — so a deployment with a
  // national id or an internal customer number had nothing that named its own data.
  it('extraPatterns masks an identifier no built-in type can name', () => {
    // A patient record number: no built-in shape comes close, and there is no country whose id list
    // could reasonably be shipped here — which is the whole reason this option exists.
    const redact = piiTextRedactor({ extraPatterns: [{ name: 'mrn', pattern: /\bMRN-\d{6}\b/g }] });
    const out = redact('dosya MRN-482100 goruldu');
    expect(out).toContain('[REDACTED_MRN]');
    expect(out).not.toContain('482100');
  });

  // Order is load-bearing, not cosmetic: the built-in `phone` pattern is greedy enough to swallow an
  // 11-digit national id, so a custom pattern running after it would find its text already masked —
  // under the wrong name, which also makes the audit report describe the wrong type.
  it('a custom pattern wins over a greedy built-in, instead of arriving after it', () => {
    const withCustom = piiTextRedactor({ extraPatterns: [{ name: 'tckn', pattern: /\b\d{11}\b/g }] });
    expect(withCustom('customer 12345678901 record')).toContain('[REDACTED_TCKN]');
    // Without it, the same text is masked by `phone` — the mislabel this ordering avoids.
    expect(piiTextRedactor()('customer 12345678901 record')).toContain('[REDACTED_PHONE]');
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
  // deployment could believe a type was covered while the value went through in the clear.
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

// The email pattern's local part used to retry from every position inside a run of word characters,
// consuming the whole run each time before failing to find `@`. Measured on a single line with no
// address in it: 10k chars 78ms, 40k 1284ms, 80k 5290ms — quadratic, on input a model transcript or
// a tool result can easily produce. The lookbehind makes a failure at one position rule out every
// position inside the run.
describe('redaction cost is linear in the input', () => {
  it('a long run of word characters does not take quadratic time', () => {
    const redact = piiTextRedactor();
    const started = Date.now();
    redact(`${'a'.repeat(80_000)}@`); // the worst case: one long local part, no domain to complete it
    const ms = Date.now() - started;
    // Generous by two orders of magnitude against the 5290ms this measured before, so the assertion
    // is about the complexity class rather than about this machine's speed.
    expect(ms, `80k characters took ${ms}ms`).toBeLessThan(500);
  });

  it('...and still masks what it did before', () => {
    const redact = piiTextRedactor();
    expect(redact('mail ali.veli+etiket@alt.ornek.com x')).toBe('mail [REDACTED_EMAIL] x');
    expect(redact('x-y@z-w.co.uk')).toBe('[REDACTED_EMAIL]');
    expect(redact('not@an'), 'a domain with no dot is not an address').toBe('not@an');
  });
});
