// End-to-end with the REAL piiRedactor, not a look-alike.
//
// WHY THIS FILE EXISTS, in packages/processors and not in packages/durable: the leak it guards was
// fixed in `run.ts`, and the test that drove that fix lives next to it — but @gnldev/durable cannot
// import @gnldev/processors (processors peer-depends on durable, not the other way round), so that
// test necessarily uses a hand-written processor "shaped like piiRedactor". That proves the
// MECHANISM carries a processor's output into memory; it cannot prove the SHIPPED redactor does.
// The dependency runs the right way here, so this file closes that gap: real `piiRedactor`, real
// `runDurable`, real `BasicMemory`, and the assertions read the thread the user would actually get.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, BasicMemory, runDurable } from '@gnldev/durable';
import { piiRedactor } from '../src/pii.js';

const EMAIL = 'ali.veli@example.com';
const CARD = '4111111111111111';

/** Minimal LanguageModelV4 mock (mirrors packages/durable/test/mock.ts, inlined to avoid a cross-package test import). */
function mockModel(reply: (options: any) => string): any {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async (options: any) => ({
      content: [{ type: 'text', text: reply(options) }],
      finishReason: { unified: 'stop', raw: 'stop' },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
      warnings: [] as any[],
    }),
    doStream: async () => {
      throw new Error('mock: doStream not supported');
    },
  };
}

/** Every string anywhere in the stored thread — the shape memory uses is not the assertion's business. */
function threadText(messages: unknown[]): string {
  return JSON.stringify(messages);
}

describe('piiRedactor + memory: the real redactor keeps raw PII out of the thread', () => {
  it('LEAK A — the user message is stored MASKED (the redactor runs before the write-ahead)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const threadId = 'thread-leak-a';

    await runDurable({
      runId: 'run-a',
      journal,
      memory,
      threadId,
      model: mockModel(() => 'understood'),
      prompt: `move my account to ${EMAIL}`,
      processors: [piiRedactor()],
    });

    const stored = threadText(await memory.getMessages(threadId));
    expect(stored).not.toContain(EMAIL); // the whole point
    expect(stored).toContain('[REDACTED_EMAIL]');
  });

  it('LEAK B — the assistant reply is stored MASKED even when the model echoes PII back', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const threadId = 'thread-leak-b';

    await runDurable({
      runId: 'run-b',
      journal,
      memory,
      threadId,
      // The model answers with a card number the user never typed — output-side redaction is the
      // Only thing standing between that and the thread.
      model: mockModel(() => `your card ${CARD} was charged`),
      prompt: 'what is the payment status',
      processors: [piiRedactor()],
    });

    const stored = threadText(await memory.getMessages(threadId));
    expect(stored).not.toContain(CARD);
    expect(stored).toContain('[REDACTED_CREDITCARD]'); // the mask is the type name uppercased, no separator
  });

  it('the model itself never receives the raw input either', async () => {
    const journal = new InMemoryJournal();
    const seen: string[] = [];

    await runDurable({
      runId: 'run-c',
      journal,
      memory: new BasicMemory(journal),
      threadId: 'thread-model',
      model: mockModel((options) => {
        seen.push(JSON.stringify(options.prompt ?? options.messages ?? ''));
        return 'ok';
      }),
      prompt: `e-postam ${EMAIL}`,
      processors: [piiRedactor()],
    });

    expect(seen.join('')).not.toContain(EMAIL);
    expect(seen.join('')).toContain('[REDACTED_EMAIL]');
  });
});
