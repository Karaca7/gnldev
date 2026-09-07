// @gnldev/client public types. Single source for Interrupt/RunSummary/JournalEntry: @gnldev/durable (type-only).
import type { Interrupt, RunSummary, JournalEntry } from '@gnldev/durable';
export type { Interrupt, RunSummary, JournalEntry };

/** @gnldev/server GET /agents output. */
export interface AgentMeta {
  name: string;
  model: string;
  system?: string;
  hasTools: boolean;
  maxSteps: number;
}

/**
 * run/resume response.
 *
 * `runId` is always present, and the client is what guarantees it: the server omits it from every
 * error body, but the client either generated the id or was handed it, so it fills it back in. It was
 * typed as a required `string` before that was true — a caller passing `r.runId` to `resume()` after a
 * refusal was passing `undefined` with the type system agreeing.
 *
 * The refusal fields are the ones @gnldev/server and @gnldev/studio actually send. Without them every
 * failure looked the same to a caller: a 409 that clears on approval, a 422 that never will, and a 429
 * that wants you to wait all arrived as one `error` string.
 */
export interface RunResult {
  ok?: boolean;
  runId: string;
  text?: string;
  interrupts: Interrupt[];
  /** Replay-disclosure zarfı (server run cevabından): bu turda journal'dan cevaplanan araçlar. */
  replayedToolCalls?: Array<{ toolCallId: string; toolName?: string; status: string; origin: 'self' | 'window' }>;
  error?: string;
  /** HTTP status, so a caller can act without parsing the sentence. Absent on success. */
  status?: number;
  /** Machine-readable refusal, e.g. 'run_thread_mismatch', 'run_busy', 'retry_limit_exceeded'. */
  code?: string;
  /** The refusal's structured half — which threads collided, which limit was hit. */
  detail?: unknown;
  /** Server's own answer to "will the same runId succeed later". */
  resumable?: boolean;
  /** Seconds to wait, when the server named one (from the Retry-After header). */
  retryAfter?: number;
}

/** run/stream input. If runId is not given, the client generates one (idempotency key). */
export interface RunInput {
  runId?: string;
  prompt?: string;
  messages?: unknown;
  threadId?: string;
  resourceId?: string;
  approvals?: Record<string, boolean>;
}

/** SSE event union (same schema as @gnldev/server + @gnldev/studio playground; P0.1 additions — see sse.ts header). */
export type StreamEvent =
  | { event: 'text-delta'; data: { text: string } }
  | { event: 'tool-call'; data: { toolCallId: string; toolName: string; input: unknown } }
  | { event: 'tool-result'; data: { toolCallId: string; toolName: string; output: unknown } }
  | { event: 'reasoning-start'; data: { id: string } }
  | { event: 'reasoning-delta'; data: { id: string; text: string } }
  | { event: 'reasoning-end'; data: { id: string } }
  | { event: 'tool-input-start'; data: { toolCallId: string; toolName: string } }
  | { event: 'tool-input-delta'; data: { toolCallId: string; delta: string } }
  | { event: 'tool-input-end'; data: { toolCallId: string } }
  | { event: 'source'; data: { sourceType?: string; id?: string; url?: string; title?: string } }
  | { event: 'file'; data: { mediaType?: string; base64?: string } }
  | { event: 'step-start'; data: Record<string, never> }
  | { event: 'step-finish'; data: { finishReason?: string; usage?: unknown } }
  | { event: 'tool-error'; data: { toolCallId: string; toolName: string; error: string } }
  | { event: 'raw'; data: { type: string } }
  | { event: 'error'; data: { error: string } }
  | { event: 'interrupt'; data: { interrupts: Interrupt[] } }
  | { event: 'done'; data: { runId: string; finishReason?: string; usage?: unknown } }
  | { event: string; data: any };

export interface StreamHandlers {
  onText?: (text: string) => void;
  onToolCall?: (tc: { toolCallId: string; toolName: string; input: unknown }) => void;
  onToolResult?: (tr: { toolCallId: string; toolName: string; output: unknown }) => void;
  /** P0.1: thinking-model reasoning deltas (absent handler = ignored, as before). */
  onReasoning?: (text: string) => void;
  onInterrupt?: (interrupts: Interrupt[]) => void;
  onError?: (error: string) => void;
  onDone?: (d: { runId: string; finishReason?: string; usage?: unknown }) => void;
  /** P0.1: catch-all for every event without a dedicated handler above (source, file, step, tool-input, raw, …). */
  onEvent?: (ev: StreamEvent) => void;
}
