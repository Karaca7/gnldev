// Demo agent: deterministic "echo" mock model that does NOT require an API key.
// To switch to a real provider: model: 'anthropic/claude-opus-4-8' (or an AI SDK model object).
import type { AgentConfig } from '@gnldev/durable';

function lastUserText(prompt: any[]): string {
  const m = [...(prompt ?? [])].reverse().find((x: any) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p: any) => p.text ?? '').join(' ');
  return '';
}

// SPEC v4, matching the `ai@^7` this project depends on. Declaring 'v2' put the SDK into
// compatibility mode and printed a warning on the FIRST run of every scaffolded project — before the
// user had written a line. The usage shape moved with it: v7 nests the counts, and a flat
// `{inputTokens: 1}` reads as undefined through the SDK's accessors, so any cost or token ceiling
// would have counted this model as free.
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

// The finish reason moved with the usage shape and only the usage half was fixed. A v4 provider
// reports `{unified, raw}`; AI SDK 7 reads `finishReason.unified`, and a bare string leaves it
// undefined. Harmless on this text-only path today, and wrong the moment anyone adds a tool — which
// is what the `full` template does, where it produced an agent that never called one. Same shape in
// both templates, so the next person to copy this file copies something correct.
const finish = (reason: 'stop' | 'tool-calls') => ({ unified: reason, raw: reason });

function echoModel(): any {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'echo',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => ({
      content: [{ type: 'text', text: `echo: ${lastUserText(prompt)}` }],
      finishReason: finish('stop'),
      usage,
      warnings: [],
    }),
    doStream: async ({ prompt }: any) => {
      const text = `echo: ${lastUserText(prompt)}`;
      return {
        stream: new ReadableStream({
          start(c) {
            c.enqueue({ type: 'stream-start', warnings: [] });
            c.enqueue({ type: 'text-start', id: '1' });
            for (const ch of text) c.enqueue({ type: 'text-delta', id: '1', delta: ch });
            c.enqueue({ type: 'text-end', id: '1' });
            c.enqueue({ type: 'finish', finishReason: finish('stop'), usage });
            c.close();
          },
        }),
      };
    },
  };
}

export const assistant: AgentConfig = {
  model: echoModel(),
  system: 'You are a helpful assistant. (Demo: echo mock model — no API key required.)',
  maxSteps: 4,
};
