// @gnldev/client — type-safe REST/SSE client for @gnldev/server (and the @gnldev/studio playground) agents.
// Framework-agnostic core. For React hooks: `@gnldev/client/react`.
import { parseSSEStream } from './sse.js';
import type { AgentMeta, JournalEntry, RunInput, RunResult, RunSummary, StreamEvent, StreamHandlers } from './types.js';

export interface GnlClientOptions {
  /** @gnldev/server root URL (e.g. 'http://localhost:3000' or '.../studio/api' for studio). */
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

/**
 * One place that reads the RESPONSE rather than only its body.
 *
 * `run`/`resume` used to be `(await res.json()) as RunResult` — a cast, not a check. A refusal came
 * back as `{error, code, detail}` with no `runId`, and the cast asserted a `runId: string` that was
 * `undefined`; a caller feeding it to `resume()` was passing nothing and the types agreed. And `code`,
 * `resumable` and `Retry-After` were dropped on the floor, so a 409 that clears on approval, a 422 that
 * never will, and a 429 that wants a wait were indistinguishable.
 *
 * `runId` comes from the CALLER's side, which is the only side that always knows it.
 */
/**
 * A refusal the server made deliberately, carried to the caller intact.
 *
 * The streaming path had no way to report one: its only guard was `!res.body`, and a JSON error body
 * IS a body, so a 409/422/429 was handed to the SSE frame parser, produced no frames, and ended the
 * loop. Measured — zero events, nothing thrown; in a React hook that is a spinner that stops with the
 * screen unchanged, which is worse than an error because there is nothing to act on or report.
 *
 * Thrown rather than yielded: a stream that will never carry a token has not "ended", it failed, and
 * `for await` cannot express that difference on its own.
 */
export class GnlHttpError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly detail?: unknown,
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'GnlHttpError';
  }

  /** Builds one from a failed Response, tolerating a body that is not JSON. */
  static async from(res: Response): Promise<GnlHttpError> {
    const raw = await res.text().catch(() => '');
    let body: { error?: string; code?: string; detail?: unknown } = {};
    try { body = raw ? JSON.parse(raw) : {}; } catch { /* not JSON: the text below is what there is */ }
    const ra = Number(res.headers.get('retry-after'));
    return new GnlHttpError(
      // `||` and not `??`: an empty body is a string, so `?? ` keeps it and the error carries no message
      // at all. Measured by the existing "no stream body" test, which is what an empty 500 looks like.
      body.error || raw.slice(0, 300) || `HTTP ${res.status}`,
      res.status,
      body.code,
      body.detail,
      Number.isFinite(ra) && ra >= 0 ? ra : undefined,
    );
  }
}

async function asRunResult(res: Response, runId: string): Promise<RunResult> {
  const body = (await res.json().catch(() => ({}))) as Partial<RunResult> & { error?: string };
  if (res.ok) return { ...body, runId: body.runId ?? runId } as RunResult;
  const ra = Number(res.headers.get('retry-after'));
  return {
    ...body,
    runId: body.runId ?? runId,
    interrupts: body.interrupts ?? [],
    error: body.error ?? `HTTP ${res.status}`,
    status: res.status,
    ...(Number.isFinite(ra) && ra >= 0 ? { retryAfter: ra } : {}),
  } as RunResult;
}

export class GnlClient {
  private baseUrl: string;
  private headers: Record<string, string>;
  private _fetch: typeof fetch;

  constructor(opts: GnlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', ...opts.headers };
    const f = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!f) throw new Error('@gnldev/client: fetch not found — provide opts.fetch (Node <18).');
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
    return asRunResult(res, runId);
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
    return asRunResult(res, runId);
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
    // A REFUSAL HAS A BODY TOO, which is why `!res.body` alone was not a guard. A 409/422/429 answers
    // with a JSON error object, so `res.body` is a perfectly good ReadableStream — it just is not SSE.
    // Fed to the frame parser it produced no frames and no error: measured, the loop yielded 0 events
    // and threw nothing, so a UI stopped its spinner and showed neither a message nor a failure.
    if (!res.ok) throw await GnlHttpError.from(res);
    if (!res.body) {
      const err = await res.text().catch(() => '');
      throw new Error(`@gnldev/client: no stream body (HTTP ${res.status}) ${err}`);
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
