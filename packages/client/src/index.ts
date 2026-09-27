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
  /**
   * Where a short-lived bearer comes from — for an end user holding its own token (`roleAuth`'s
   * `endUsers`). Called before the first request, again when the held token is within
   * `refreshSkewSec` of its `exp`, and once after a 401 (the request is then retried once). Concurrent
   * requests share one call. Return `null` when there is no session: the request goes out without a
   * token and the server's 401 is what the caller sees. GNL keeps no refresh state — the application's
   * own session decides whether a new token is minted (see `tokenFrom` and @gnldev/auth
   * `subjectTokenEndpoint`). Overrides an `Authorization` in `headers`.
   */
  getToken?: () => Promise<string | null> | string | null;
  /** Refresh this many seconds before `exp` (read from the token, unverified). Default 30. */
  refreshSkewSec?: number;
}

/** `exp` of a JWT in ms, read without verifying (the server verifies); Infinity when unreadable. */
function expMsOf(token: string): number {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const exp = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4))).exp;
    return typeof exp === 'number' ? exp * 1000 : Infinity;
  } catch {
    return Infinity;
  }
}

/**
 * A `getToken` that asks the application's own token endpoint (POST, same-origin cookies). A 401 or
 * 403 there means "no session" → `null`; any other failure throws, so a network blip is not read as
 * a logout.
 */
export function tokenFrom(url: string, opts: { fetch?: typeof fetch } = {}): () => Promise<string | null> {
  const f = opts.fetch ?? globalThis.fetch.bind(globalThis);
  return async () => {
    const res = await f(url, { method: 'POST', credentials: 'same-origin', headers: { accept: 'application/json' } });
    if (res.status === 401 || res.status === 403) return null;
    if (!res.ok) throw new Error(`@gnldev/client: token endpoint answered HTTP ${res.status}`);
    const body = (await res.json()) as { token?: unknown };
    return typeof body.token === 'string' ? body.token : null;
  };
}

/** Generate a unique runId (idempotency key). UUID if crypto is available, else time+random. */
export function genRunId(): string {
  const g = globalThis as any;
  if (g.crypto?.randomUUID) return g.crypto.randomUUID();
  return 'run-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1e9).toString(36);
}

/**
 * The runId to send, or `undefined` when the caller named the WORK instead.
 *
 * One line with one decision in it, in one place, because the three call sites below had three
 * copies of the old `input.runId ?? genRunId()` and would have grown three copies of this. Naming
 * work and naming an id are mutually exclusive at the server; generating a "helpful" id beside a
 * workKey sends both and gets the request refused.
 */
function identityOf(input: RunInput): string | undefined {
  if (input.runId) return input.runId;
  return input.workKey ? undefined : genRunId();
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

async function asRunResult(res: Response, runId?: string): Promise<RunResult> {
  const body = (await res.json().catch(() => ({}))) as Partial<RunResult> & { error?: string };
  // WHERE THE ID COMES FROM, in the order of who actually knows it. The body, when the server sent
  // one. Then `X-Gnl-Run-Id`, which every run/stream response carries and which is the ONLY source
  // on two paths that used to leave `runId` a lie: a refusal (error bodies have no `runId` field)
  // and a call that named WORK instead of an id (the caller never had one to fall back to). Then the
  // caller's own, which is the only side that always knows it on the raw path.
  // `''` is the honest floor, not a lie: on the workKey path a PRE-RUN refusal (unknown agent,
  // unaddressable scope) carries neither a body runId nor the header — no run ever existed to name.
  // The type keeps `runId: string` for every caller who logs or maps on it; test for truthiness
  // before treating it as an address.
  const effective = body.runId ?? res.headers.get('X-Gnl-Run-Id') ?? runId ?? '';
  if (res.ok) return { ...body, runId: effective } as RunResult;
  const ra = Number(res.headers.get('retry-after'));
  return {
    ...body,
    runId: effective,
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
  private getToken?: GnlClientOptions['getToken'];
  private skewMs: number;
  private held?: { token: string | null; expMs: number };
  private refreshing?: Promise<string | null>;

  constructor(opts: GnlClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '');
    this.headers = { 'content-type': 'application/json', ...opts.headers };
    const f = opts.fetch ?? (globalThis.fetch ? globalThis.fetch.bind(globalThis) : undefined);
    if (!f) throw new Error('@gnldev/client: fetch not found — provide opts.fetch (Node <18).');
    const base = f;
    this.getToken = opts.getToken;
    this.skewMs = (opts.refreshSkewSec ?? 30) * 1000;
    // Every request goes through here, so no method can forget the token or the retry.
    this._fetch = this.getToken ? ((input: any, init?: RequestInit) => this.authedFetch(base, input, init)) as typeof fetch : base;
  }

  /** One refresh at a time: every caller waiting on an expired token awaits the same promise. */
  private refresh(): Promise<string | null> {
    this.refreshing ??= (async () => {
      try {
        const token = (await this.getToken!()) ?? null;
        this.held = { token, expMs: token ? expMsOf(token) : Infinity };
        return token;
      } finally {
        this.refreshing = undefined;
      }
    })();
    return this.refreshing;
  }

  /** The token to send, and whether it was minted for this very request. */
  private async tokenNow(): Promise<{ token: string | null; fresh: boolean }> {
    if (this.refreshing) return { token: await this.refreshing, fresh: true };
    if (this.held && (this.held.token === null || Date.now() < this.held.expMs - this.skewMs)) return { token: this.held.token, fresh: false };
    return { token: await this.refresh(), fresh: true };
  }

  private async authedFetch(base: typeof fetch, input: any, init: RequestInit = {}): Promise<Response> {
    const send = (token: string | null) => {
      const headers = new Headers(init.headers);
      if (token) headers.set('authorization', `Bearer ${token}`);
      else headers.delete('authorization');
      return base(input, { ...init, headers });
    };
    const { token, fresh } = await this.tokenNow();
    const res = await send(token);
    // A 401 on a token minted for this request will not be cured by minting another.
    if (res.status !== 401 || fresh) return res;
    // A 401 is decided before the server does any work, so resending the same body is safe. If the
    // token we sent is no longer the one held, someone already refreshed — use theirs, do not refresh again.
    const next = this.held?.token !== token && this.held ? this.held.token : await this.refresh();
    if (!next || next === token) return res;
    await res.body?.cancel().catch(() => {});
    return send(next);
  }

  private url(p: string): string {
    return this.baseUrl + p;
  }

  /** List of registered agent metadata (GET /agents). */
  async listAgents(): Promise<AgentMeta[]> {
    return this.okJson<AgentMeta[]>(await this._fetch(this.url('/agents'), { headers: this.headers }));
  }

  /**
   * A read's body, or a `GnlHttpError`. `listAgents`/`listRuns`/`getRun` each cast the body and
   * never looked at the status: an expired token's `{ error: 'unauthorized' }` came back as the
   * run list — measured — so a caller iterated an object and nothing said why.
   */
  private async okJson<T>(res: Response): Promise<T> {
    if (!res.ok) throw await GnlHttpError.from(res);
    return (await res.json()) as T;
  }

  /**
   * Run an agent durably (POST /agents/:name/run).
   *
   * A runId is generated ONLY when the caller named neither half of the identity pair. A caller who
   * passed a `workKey` has named the work, and adding an id beside it would send both halves of an
   * exclusive pair — the server refuses that, so the convenience would turn a good request into a
   * 400. The generated fallback is unchanged for everyone else.
   */
  async run(name: string, input: RunInput = {}): Promise<RunResult> {
    const runId = identityOf(input);
    const res = await this._fetch(this.url(`/agents/${encodeURIComponent(name)}/run`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(runId === undefined ? input : { ...input, runId }),
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
    const runId = identityOf(input); // see run() — no invented id beside a workKey
    const res = await this._fetch(this.url(`/agents/${encodeURIComponent(name)}/stream`), {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(runId === undefined ? input : { ...input, runId }),
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

  /**
   * Consume the stream with handler callbacks (convenience). Returns the runId the run landed on —
   * which, when the caller named WORK, is only knowable from the stream's own `done` event: the
   * engine derived the id and the caller never held it.
   */
  async streamTo(name: string, input: RunInput, handlers: StreamHandlers, signal?: AbortSignal): Promise<{ runId: string }> {
    const local = identityOf(input);
    let runId = local ?? '';
    for await (const ev of this.stream(name, local === undefined ? input : { ...input, runId: local }, signal)) {
      // The engine's own answer, whatever the caller sent — on the derived path it is the first time
      // this side sees the id at all.
      if (ev.event === 'done' && typeof (ev.data as { runId?: unknown })?.runId === 'string') {
        runId = (ev.data as { runId: string }).runId;
      }
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
    return this.okJson<RunSummary[]>(await this._fetch(this.url('/runs'), { headers: this.headers }));
  }

  /** A run's journal timeline (GET /runs/:id). */
  async getRun(id: string): Promise<JournalEntry[]> {
    // A 404 means no such run, or not yours — the server does not say which.
    return this.okJson<JournalEntry[]>(await this._fetch(this.url(`/runs/${encodeURIComponent(id)}`), { headers: this.headers }));
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
