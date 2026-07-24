// API-key'siz demo storage: createRestApi + echo mock model. Frontend (Vite :5173) buraya proxy'lenir.
import { serve } from '@hono/node-server';
import { createRestApi } from '@gnl/server';
import { InMemoryJournal } from '@gnl/durable';
import type { AgentConfig } from '@gnl/durable';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
function lastUserText(prompt: any[]): string {
  const m = [...(prompt ?? [])].reverse().find((x: any) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p: any) => p.text ?? '').join(' ');
  return '';
}
function echoModel(): any {
  return {
    specificationVersion: 'v2',
    provider: 'mock',
    modelId: 'echo',
    supportedUrls: {},
    doGenerate: async ({ prompt }: any) => ({ content: [{ type: 'text', text: `echo: ${lastUserText(prompt)}` }], finishReason: 'stop', usage, warnings: [] }),
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

const assistant: AgentConfig = { model: echoModel(), system: 'demo asistan', maxSteps: 4 };
const api = createRestApi({ journal: new InMemoryJournal(), agents: { assistant } });

serve({ fetch: api.fetch, port: 3000 }, (info) => console.log(`gnl storage → http://localhost:${info.port}`));
