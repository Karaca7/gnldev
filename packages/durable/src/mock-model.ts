// Deterministic mock models for demos, scaffolds and tests — no API key, no network.
//
// This is FRAMEWORK plumbing, deliberately: for a long time the scaffold copied ~60 lines of
// LanguageModel spec-v4 internals into every new project's `src/model.ts`, so the first file a new
// user opened was the scariest one in the repo — full of usage-shape and finish-reason lore they
// will never write themselves (a real provider is five lines). The lore lives here now, versioned
// and tested once, and a scaffolded agent file is the size it should be.
//
// NOT for production: these models answer from a script. The scaffold README and `gnl add model
// <provider>` are the road off of them.

import type { ModelInput } from './types.js';

/** AI SDK 7 reads nested token counts; a flat `{inputTokens: 1}` reads as undefined through its
 *  accessors, so any cost or token ceiling would count a mock as free. */
const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: 1, reasoning: undefined },
};

/** A v4 provider reports `{unified, raw}`; AI SDK 7 reads `finishReason.unified`. A bare string
 *  leaves it undefined — and from ai@7.0.70 the loop stops before executing a tool, so a mock that
 *  exists to demonstrate a tool call would demonstrate nothing. Measured on 7.0.69 vs 7.0.73. */
const finish = (reason: 'stop' | 'tool-calls') => ({ unified: reason, raw: reason });

function lastUserText(prompt: unknown[]): string {
  const m = [...((prompt as Array<{ role?: string; content?: unknown }>) ?? [])]
    .reverse()
    .find((x) => x.role === 'user');
  if (!m) return '';
  if (typeof m.content === 'string') return m.content;
  if (Array.isArray(m.content)) return m.content.map((p: { text?: string }) => p.text ?? '').join(' ');
  return '';
}

function toolResultsSeen(prompt: unknown[]): number {
  let n = 0;
  for (const m of (prompt as Array<{ role?: string; content?: unknown }>) ?? []) {
    if (m.role === 'tool') n++;
    if (Array.isArray(m.content)) for (const p of m.content) if ((p as { type?: string })?.type === 'tool-result') n++;
  }
  return n;
}

function streamOf(text: string): { stream: ReadableStream } {
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
}

/**
 * Echoes the last user message back. The smallest thing that lets `pnpm dev` work with no key:
 * the run is journaled, the thread is real, Studio shows a timeline — only the words are silly.
 */
export function echoModel(): ModelInput {
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'echo',
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: unknown[] }) => ({
      content: [{ type: 'text', text: `echo: ${lastUserText(prompt)}` }],
      finishReason: finish('stop'),
      usage,
      warnings: [],
    }),
    doStream: async ({ prompt }: { prompt: unknown[] }) => streamOf(`echo: ${lastUserText(prompt)}`),
  };
}

export interface ToolCallingModelOptions {
  /** Tool to call on the first turn. Default `'chargeOrder'`. */
  toolName?: string;
  /** Arguments for that call. Default `{ orderId: 'order-1', amount: 42 }`. */
  input?: Record<string, unknown>;
  /**
   * How many DUPLICATE calls to emit in that one turn, each under a fresh toolCallId. Default 1.
   * 3 reproduces the documented AI SDK pattern behind most real double-side-effect incidents — the
   * model re-planning the same work under new ids — which is exactly what `idempotency: 'args'`
   * exists to absorb; the scaffold's proof test runs on it.
   */
  calls?: number;
  /** What the model says once a tool result is visible. */
  doneText?: string;
}

/**
 * First turn: calls `toolName` (once, or `calls` times under distinct toolCallIds). Next turn —
 * decided by looking for tool results in the prompt, so replays and resumes stay deterministic —
 * it answers with `doneText`. Gives a scaffold a REAL tool call to inspect in Studio, keyless.
 */
export function toolCallingModel(opts: ToolCallingModelOptions = {}): ModelInput {
  const toolName = opts.toolName ?? 'chargeOrder';
  const input = JSON.stringify(opts.input ?? { orderId: 'order-1', amount: 42 });
  const calls = opts.calls ?? 1;
  const doneText = opts.doneText ?? 'Order charged once. Run the same work again — it will not charge twice.';
  return {
    specificationVersion: 'v4',
    provider: 'mock',
    modelId: 'demo',
    supportedUrls: {},
    doGenerate: async ({ prompt }: { prompt: unknown[] }) => {
      if (toolResultsSeen(prompt) === 0) {
        return {
          content: Array.from({ length: calls }, (_, i) => ({
            type: 'tool-call',
            toolCallId: `call-${i + 1}`,
            toolName,
            input,
          })),
          finishReason: finish('tool-calls'),
          usage,
          warnings: [],
        };
      }
      return { content: [{ type: 'text', text: doneText }], finishReason: finish('stop'), usage, warnings: [] };
    },
    doStream: async () => streamOf(doneText),
    // Cast, and worth one line: these are hand-built spec-v4 objects, so they satisfy the provider
    // CONTRACT (mock-model.test.ts drives both through `ai`'s own generateText) without satisfying
    // the SDK's declared interface structurally. Returning `unknown` instead put the cast in every
    // scaffolded project — measured: a fresh `gnl init --serving own` did not typecheck, because
    // `AgentConfig.model` is `ModelInput` and `unknown` is not assignable to it.
  } as unknown as ModelInput;
}
