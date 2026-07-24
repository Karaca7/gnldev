// Demo agent: deterministic "echo" mock model that does NOT require an API key.
// To switch to a real provider: model: 'anthropic/claude-opus-4-8' (or an AI SDK model object).
import type { AgentConfig } from '@gnl/durable';

function lastUserText(prompt: any[]): string {
  const m = [...(prompt ?? [])].reverse().find((x: any) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p: any) => p.text ?? '').join(' ');
  return '';
}

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function echoModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'echo',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => ({
      content: [{ type: 'text', text: `echo: ${lastUserText(prompt)}` }],
      finishReason: 'stop',
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
            c.enqueue({ type: 'finish', finishReason: 'stop', usage });
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
