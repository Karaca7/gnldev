// P2 (AUDIT-R2): tokenLimiter — "TokenLimiter" (fuller sibling of tokenLimit).
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, createProcessorCtx, readProcessorReports, ProcessorTripwire } from '@gnl/durable';
import { tokenLimiter } from '../src/token-limiter.js';

const ctx = { runId: 'r', journal: {} as any, step: async (_n: string, c: any) => c() } as any;
const u = (c: string) => ({ role: 'user', content: c });
const a = (c: string) => ({ role: 'assistant', content: c });
const sys = (c: string) => ({ role: 'system', content: c });

describe('tokenLimiter — under limit', () => {
  it('leaves the input untouched when under maxInputTokens', () => {
    const input = { system: 'sys', messages: [u('hello'), a('hi')] };
    const out = tokenLimiter({ maxInputTokens: 1000 }).processInput!(input, ctx) as any;
    expect(out).toEqual(input);
  });
});

describe('tokenLimiter — trim-oldest (default)', () => {
  it('trims oldest non-protected messages first, keeping system + the last user message', () => {
    // Each 'x'.repeat(40) message ≈ 10 tokens (char/4 heuristic). Budget 25 tokens.
    const big = 'x'.repeat(40); // ~10 tokens
    const messages = [
      sys('system prompt'),      // protected (role: system)
      u(big),                    // oldest droppable — index 1
      a(big),                    // index 2
      u(big),                    // index 3
      a(big),                    // index 4
      u(big),                    // LAST user message — protected, index 5
    ];
    const out = tokenLimiter({ maxInputTokens: 25 }).processInput!({ messages }, ctx) as any;
    const roles = out.messages.map((m: any) => m.role);
    // system + last user are always present; oldest droppable entries are removed first.
    expect(out.messages[0]).toBe(messages[0]); // system kept
    expect(out.messages[out.messages.length - 1]).toBe(messages[5]); // last user kept
    expect(out.messages.length).toBeLessThan(messages.length);
    // Whatever remains besides system/last-user must be more recent than what was dropped:
    // i.e. index 1 (oldest droppable) must be gone if anything was dropped at all.
    expect(out.messages).not.toContain(messages[1]);
    expect(roles).toContain('system');
    expect(roles.filter((r: string) => r === 'user').length).toBeGreaterThanOrEqual(1);
  });

  it('never drops the last user message even if it alone is the only thing over budget', () => {
    const huge = 'y'.repeat(4000); // ~1000 tokens
    const messages = [u('short'), a('short'), u(huge)];
    const out = tokenLimiter({ maxInputTokens: 5 }).processInput!({ messages }, ctx) as any;
    expect(out.messages).toEqual([messages[2]]);
  });

  it('never drops system messages (keepSystem default true) even under a tiny budget', () => {
    const huge = 'y'.repeat(4000);
    const messages = [sys('system rules'), u(huge), u('final question')];
    const out = tokenLimiter({ maxInputTokens: 1 }).processInput!({ messages }, ctx) as any;
    expect(out.messages).toContainEqual(messages[0]);
    expect(out.messages).toContainEqual(messages[2]); // last user
  });

  it('keepSystem: false — a system message in the array CAN be dropped (only last-user stays protected)', () => {
    const huge = 'y'.repeat(4000);
    const messages = [sys('system rules'), u(huge), u('final question')];
    const out = tokenLimiter({ maxInputTokens: 1, keepSystem: false }).processInput!({ messages }, ctx) as any;
    expect(out.messages).not.toContainEqual(messages[0]);
    expect(out.messages).toContainEqual(messages[2]);
  });

  it('input.system (the separate system-prompt field) is never trimmed', () => {
    const longSystem = 'S'.repeat(4000);
    const out = tokenLimiter({ maxInputTokens: 5 }).processInput!({ system: longSystem, messages: [u('hi')] }, ctx) as any;
    expect(out.system).toBe(longSystem);
  });

  it('no messages at all → input returned untouched even if system alone is over budget', () => {
    const input = { system: 'S'.repeat(4000) };
    const out = tokenLimiter({ maxInputTokens: 1 }).processInput!(input, ctx) as any;
    expect(out).toEqual(input);
  });
});

describe("tokenLimiter — strategy: 'error'", () => {
  it('throws ProcessorTripwire synchronously when over budget; does not touch the input', () => {
    const messages = [u('a'.repeat(400))]; // ~100 tokens
    const proc = tokenLimiter({ maxInputTokens: 10, strategy: 'error' });
    expect(() => proc.processInput!({ messages }, ctx)).toThrow(ProcessorTripwire);
  });

  it('does not throw when under budget', () => {
    const proc = tokenLimiter({ maxInputTokens: 1000, strategy: 'error' });
    expect(() => proc.processInput!({ messages: [u('short')] }, ctx)).not.toThrow();
  });
});

describe('tokenLimiter — custom countTokens', () => {
  it('honors a custom tokenizer instead of the char/4 default', () => {
    // Custom counter: 1 token per message regardless of length → budget of 2 keeps only 2 messages.
    const messages = [u('short'), a('short'), u('huge '.repeat(1000))];
    const proc = tokenLimiter({ maxInputTokens: 2, countTokens: () => 1 });
    const out = proc.processInput!({ messages }, ctx) as any;
    // total = 3 tokens > 2 → oldest droppable (index 0) dropped; last user (index 2) + index 1 remain (2 tokens).
    expect(out.messages).toEqual([messages[1], messages[2]]);
  });

  it("custom countTokens=()=>0 → never over budget, strategy 'error' never throws", () => {
    const proc = tokenLimiter({ maxInputTokens: 1, countTokens: () => 0, strategy: 'error' });
    expect(() => proc.processInput!({ messages: [u('x'.repeat(10000))] }, ctx)).not.toThrow();
  });
});

describe('tokenLimiter — recordProcessorReport (real journal)', () => {
  it('trim-oldest: a report is written with droppedCount when messages are actually dropped', async () => {
    const journal = new InMemoryJournal();
    const rctx = createProcessorCtx(journal, 'run-tl-trim');
    const big = 'x'.repeat(4000);
    const messages = [u(big), a(big), u('final')];
    tokenLimiter({ maxInputTokens: 5 }).processInput!({ messages }, rctx);
    await new Promise((r) => setTimeout(r, 0));
    const reports = await readProcessorReports(journal, 'run-tl-trim');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ name: 'token-limiter', phase: 'input' });
    expect((reports[0]!.findings as any).droppedCount).toBeGreaterThan(0);
  });

  it("'error' strategy: a report is written before the throw", async () => {
    const journal = new InMemoryJournal();
    const rctx = createProcessorCtx(journal, 'run-tl-err');
    const proc = tokenLimiter({ maxInputTokens: 5, strategy: 'error' });
    expect(() => proc.processInput!({ messages: [u('x'.repeat(400))] }, rctx)).toThrow(ProcessorTripwire);
    await new Promise((r) => setTimeout(r, 0));
    const reports = await readProcessorReports(journal, 'run-tl-err');
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ name: 'token-limiter', phase: 'input' });
  });

  it('no report is written when under budget', async () => {
    const journal = new InMemoryJournal();
    const rctx = createProcessorCtx(journal, 'run-tl-clean');
    tokenLimiter({ maxInputTokens: 1000 }).processInput!({ messages: [u('hi')] }, rctx);
    await new Promise((r) => setTimeout(r, 0));
    expect(await readProcessorReports(journal, 'run-tl-clean')).toEqual([]);
  });
});
