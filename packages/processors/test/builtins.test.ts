// @gnl/processors built-ins: piiRedactor (5 PII types), moderation tripwire, toolFilter.
import { describe, it, expect } from 'vitest';
import { piiRedactor } from '../src/pii.js';
import { moderationProcessor } from '../src/moderation.js';
import { toolFilter } from '../src/tool-filter.js';
import { ProcessorTripwire } from '@gnl/durable';

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
