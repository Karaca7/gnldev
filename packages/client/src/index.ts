// @gnl/client — type-safe REST/SSE client for @gnl/server (and the @gnl/studio playground) agents.
// Framework-agnostic core. For React hooks: `@gnl/client/react`.
import { parseSSEStream } from './sse.js';
import type { AgentMeta, JournalEntry, RunInput, RunResult, RunSummary, StreamEvent, StreamHandlers } from './types.js';

export interface GnlClientOptions {
  /** @gnl/server root URL (e.g. 'http://localhost:3000' or '.../studio/api' for studio). */
  baseUrl: string;
  /** Headers added to every request (e.g. Authorization). */
  headers?: Record<string, string>;
  /** Custom fetch (for Node <18 or test mocks). */
  fetch?: typeof fetch;
}

/** Generate a unique runId (idempotency key). UUID if crypto is available, else time+random. */
export function genRunId(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

export class GnlClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private _fetch: typeof fetch;

  constructor(opts: GnlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', ...opts.headers };
    const f = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!f) throw new Error('@gnl/client: fetch not found — provide opts.fetch (Node <18).');
    this._fetch = f;
  }

  private url(p: string): string {
    return this.baseUrl + p;
  }

  /** List of registered agent metadata (GET /agents). */
  async listAgents(): Promise<AgentMeta[]> {
    const res = await this._fetch(this.url('/agents'), { headers: this.headers });
    return (await res.json()) as AgentMeta[];
  }

  /** Run an agent durably (POST /agents/:name/run). runId is generated if not given. */
  async run(name: string, input: RunInput = {}): Promise<RunResult> {
    const runId = input.runId ?? genRunId();
    const res = await this._fetch(this.url(`/agents/${encodeURIComponent(name)}/run`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ ...input, runId }),
    });
    return (await res.json()) as RunResult;
  }

  /** Continue after approval: same runId + approvals → suspended tool is released (input recorded in the journal). */
  async resume(
    name: string,
    runId: string,
    approvals: Record<string, boolean>,
    input: Omit<RunInput, 'runId' | 'approvals'> = {},
  ): Promise<RunResult> {
    const res = await this._fetch(this.url(`/agents/${encodeURIComponent(name)}/run`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ ...input, runId, approvals }),
    });
    return (await res.json()) as RunResult;
  }

  /** Run an agent with streaming (POST /agents/:name/stream) — yields SSE events. */
  async *stream(name: string, input: RunInput = {}, signal?: AbortSignal): AsyncGenerator<StreamEvent> {
    const runId = input.runId ?? genRunId();
    const res = await this._fetch(this.url(`/agents/${encodeURIComponent(name)}/stream`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ ...input, runId }),
      signal,
    });
    if (!res.body) {
      const err = await res.text().catch(() => '');
      throw new Error(`@gnl/client: no stream body (HTTP ${res.status}) ${err}`);
    }
    for await (const ev of parseSSEStream(res.body)) yield ev as StreamEvent;
  }

  /** Consume the stream with handler callbacks (convenience). Returns the runId used. */
  async streamTo(name: string, input: RunInput, handlers: StreamHandlers, signal?: AbortSignal): Promise<{ runId: string }> {
    const runId = input.runId ?? genRunId();
    for await (const ev of this.stream(name, { ...input, runId }, signal)) {
      switch (ev.event) {
        case 'text-delta':
          handlers.onText?.((ev.data as any).text);
          break;
        case 'tool-call':
          handlers.onToolCall?.(ev.data as any);
          break;
        case 'tool-result':
          handlers.onToolResult?.(ev.data as any);
          break;
        case 'interrupt':
          handlers.onInterrupt?.((ev.data as any).interrupts);
          break;
        case 'error':
          handlers.onError?.((ev.data as any).error);
          break;
        case 'done':
          handlers.onDone?.(ev.data as any);
          break;
        case 'reasoning-delta':
          handlers.onReasoning?.((ev.data as any).text); // P0.1: thinking trace
          handlers.onEvent?.(ev);
          break;
        default:
          handlers.onEvent?.(ev); // P0.1: source/file/step-*/tool-input-*/tool-error/raw — never silently lost
          break;
      }
    }
    return { runId };
  }

  /** All run summaries (GET /runs). */
  async listRuns(): Promise<RunSummary[]> {
    const res = await this._fetch(this.url('/runs'), { headers: this.headers });
    return (await res.json()) as RunSummary[];
  }

  /** A run's journal timeline (GET /runs/:id). */
  async getRun(id: string): Promise<JournalEntry[]> {
    const res = await this._fetch(this.url(`/runs/${encodeURIComponent(id)}`), { headers: this.headers });
    return (await res.json()) as JournalEntry[];
  }
}

export { parseSSEStream } from './sse.js';
export {
  applyStreamEvent,
  applyRunResult,
  appendUserMessage,
  initialChatState,
  type ChatMessage,
  type ChatState,
} from './accumulator.js';
export type {
  AgentMeta,
  RunResult,
  RunInput,
  StreamEvent,
  StreamHandlers,
  Interrupt,
  RunSummary,
  JournalEntry,
} from './types.js';
