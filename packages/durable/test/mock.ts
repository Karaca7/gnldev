// Test helpers: sets up a MockLanguageModelV2 that responds based on conversation
// state, to drive the AI SDK loop with a real `generateText`.

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };

/** Number of completed tool results (role: 'tool') in the prompt = how many tools ran. */
export function countToolResults(prompt: any[]): number {
  return (prompt ?? []).filter((m) => m?.role === 'tool').length;
}

/** doGenerate result representing the model making a tool call. */
export function toolCallResult(toolName: string, toolCallId: string, args: unknown) {
  return {
    content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(args) }],
    finishReason: 'tool-calls' as const,
    usage,
    warnings: [] as any[],
  };
}

/** doGenerate result representing the model writing the final text. */
export function finalTextResult(text: string) {
  return {
    content: [{ type: 'text', text }],
    finishReason: 'stop' as const,
    usage,
    warnings: [] as any[],
  };
}

/** Minimal LanguageModelV2 mock, without depending on ai/test (and transitively msw). */
export function createMockModel(doGenerate: (options: any) => Promise<any>): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'mock-model',
    supportedUrls: {},
    doGenerate,
    doStream: async () => {
      throw new Error('mock: doStream not supported');
    },
  };
}

/** Agent mock that streams based on conversation state (for streamDurable e2e). 0 tool results → chargeCard
 * tool-call stream; then final text stream. counter.calls counts underlying doStream calls. */
export function createMockStreamAgent(counter?: { calls: number }): any {
  const usage = { inputTokens: 5, outputTokens: 5, totalTokens: 10 };
  const parts = (arr: any[]) =>
    new ReadableStream({
      start(c) {
        for (const p of arr) c.enqueue(p);
        c.close();
      },
    });
  return {
    specificationVersion: 'v2',
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
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]),
        };
      }
      return {
        stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'Charged $20.' },
          { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
      };
    },
  };
}

/** Mock model returning fixed stream parts (for the streaming replay test). counter.calls counts calls. */
export function createMockStreamModel(parts: any[], counter?: { calls: number }): any {
  return {
    specificationVersion: 'v2',
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
