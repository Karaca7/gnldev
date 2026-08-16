// Test helpers: a mock language model that responds based on conversation state, driving the AI SDK
// loop with a real `generateText`/`streamText`.
//
// SPEC v4 ON PURPOSE. These mocks used to declare `specificationVersion: 'v2'`, which AI SDK 7
// accepts through a compatibility shim — it silently rewrites usage and finishReason on the way
// through. That meant the suite exercised the SHIM rather than the path a real provider takes, and
// tests then compared against the pre-conversion shape. Declaring v4 makes the fixtures produce
// exactly what a current provider produces, so what the journal records here is what it records in
// production.

/** v4 usage: counts are nested, and there is no top-level total. */
const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 5, text: 5, reasoning: undefined },
};

/** v4 finish reason: the SDK's unified word plus whatever the provider said. */
const finish = (reason: string) => ({ unified: reason, raw: reason });

/** Number of completed tool results (role: 'tool') in the prompt = how many tools ran. */
export function countToolResults(prompt: any[]): number {
  return (prompt ?? []).filter((m) => m?.role === 'tool').length;
}

/** doGenerate result representing the model making a tool call. */
export function toolCallResult(toolName: string, toolCallId: string, args: unknown) {
  return {
    content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(args) }],
    finishReason: finish('tool-calls'),
    usage,
    warnings: [] as any[],
  };
}

/** doGenerate result representing the model writing the final text. */
export function finalTextResult(text: string) {
  return {
    content: [{ type: 'text', text }],
    finishReason: finish('stop'),
    usage,
    warnings: [] as any[],
  };
}


/**
 * Normalises a test-authored result into the v4 wire shape.
 *
 * Tests write `usage: { inputTokens: 12, outputTokens: 3 }` and `finishReason: 'stop'` because that
 * is readable, and forty of them do. A real v4 provider emits nested counts and a `{unified, raw}`
 * reason, and AI SDK 7 reads `usage.inputTokens.total` directly — a flat literal crashes it inside
 * `asLanguageModelUsage`. So the FIXTURE converts, exactly as a provider would.
 *
 * This is not a way to make assertions pass: no test's expectations are touched, and the real record
 * shape is asserted independently in sdk-contract.test.ts, which fails if the SDK moves again.
 */
function toWireResult(r: any): any {
  if (!r || typeof r !== 'object') return r;
  const out = { ...r };
  const u = r.usage;
  if (u && typeof u.inputTokens !== 'object') {
    out.usage = {
      inputTokens: { total: u.inputTokens ?? 0, noCache: u.inputTokens ?? 0, cacheRead: u.cachedInputTokens, cacheWrite: undefined },
      outputTokens: { total: u.outputTokens ?? 0, text: u.outputTokens ?? 0, reasoning: undefined },
    };
  }
  if (typeof r.finishReason === 'string') out.finishReason = { unified: r.finishReason, raw: r.finishReason };
  return out;
}

/** Minimal LanguageModelV4 mock, without depending on ai/test (and transitively msw). */
export function createMockModel(doGenerate: (options: any) => Promise<any>): any {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate: async (options: any) => toWireResult(await doGenerate(options)),
    doStream: async () => {
      throw new Error('mock: doStream not supported');
    },
  };
}

/** Agent mock that streams based on conversation state (for streamDurable e2e). 0 tool results → chargeCard
 * tool-call stream; then final text stream. counter.calls counts underlying doStream calls. */
export function createMockStreamAgent(counter?: { calls: number }): any {
  const usage = {
    inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 5, text: 5, reasoning: undefined },
  };
  const parts = (arr: any[]) =>
    new ReadableStream({
      start(c) {
        for (const p of arr) c.enqueue(p);
        c.close();
      },
    });
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-stream-agent',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('this mock is stream-only');
    },
    doStream: async ({ prompt }: any) => {
      if (counter) counter.calls++;
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        return {
          stream: parts([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'call-charge', toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) },
            { type: 'finish', finishReason: finish('tool-calls'), usage },
          ]),
        };
      }
      return {
        stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'Charged $20.' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: finish('stop'), usage },
        ]),
      };
    },
  };
}

/** Mock model returning fixed stream parts (for the streaming replay test). counter.calls counts calls. */
export function createMockStreamModel(parts: any[], counter?: { calls: number }): any {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'mock-stream',
    supportedUrls: {},
    doGenerate: async () => {
      throw new Error('this mock is stream-only');
    },
    doStream: async () => {
      if (counter) counter.calls++;
      const stream = new ReadableStream({
        start(controller) {
          for (const p of parts) controller.enqueue(p);
          controller.close();
        },
      });
      return { stream, rawCall: { rawPrompt: null, rawSettings: {} } };
    },
  };
}
