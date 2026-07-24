// Shared test fixtures: minimal LanguageModelV2 mocks, state-based on conversation content (not a
// local call counter) — the same pattern examples/showcase/src/mock.ts uses, which is what makes a
// script survive across a FRESH model instance on resume (durable-model.ts only calls doGenerate for
// steps that are not already journaled; a step-counter closure would restart at 0 and desync).
const usage = { inputTokens: 3, outputTokens: 2, totalTokens: 5 };

export function countToolResults(prompt: any[]): number {
  return (prompt ?? []).filter((m: any) => m?.role === 'tool').length;
}

export function finalText(text: string) {
  return { content: [{ type: 'text', text }], finishReason: 'stop' as const, usage, warnings: [] as any[] };
}

export function toolCall(toolName: string, toolCallId: string, input: unknown) {
  return { content: [{ type: 'tool-call', toolCallId, toolName, input: JSON.stringify(input) }], finishReason: 'tool-calls' as const, usage, warnings: [] as any[] };
}

export function mkModel(doGenerate: (opts: any) => Promise<any>): any {
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

/** 0 tool results in the prompt so far -> call `toolName`; otherwise -> final text. */
export function agentModel(toolName: string, toolCallId: string, input: unknown, final = 'Done.'): any {
  return mkModel(async ({ prompt }: any) => (countToolResults(prompt) === 0 ? toolCall(toolName, toolCallId, input) : finalText(final)));
}

/** Captures console.log calls made during `fn()`, restores console.log afterward. */
export async function captureLog(fn: () => Promise<void>): Promise<string[]> {
  const lines: string[] = [];
  const orig = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => String(a)).join(' '));
  };
  try {
    await fn();
  } finally {
    console.log = orig;
  }
  return lines;
}
