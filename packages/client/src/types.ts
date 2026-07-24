// @gnl/client public types. Single source for Interrupt/RunSummary/JournalEntry: @gnl/durable (type-only).
import type { Interrupt, RunSummary, JournalEntry } from '@gnl/durable';
export type { Interrupt, RunSummary, JournalEntry };

/** @gnl/server GET /agents output. */
export interface AgentMeta {
  name: string;
  model: string;
  system?: string;
  hasTools: boolean;
  maxSteps: number;
}

/** run/resume response. */
export interface RunResult {
  ok?: boolean;
  runId: string;
  text?: string;
  interrupts: Interrupt[];
  error?: string;
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

/** SSE event union (same schema as @gnl/server + @gnl/studio playground; P0.1 additions — see sse.ts header). */
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
