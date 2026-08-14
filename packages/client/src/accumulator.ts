// Pure stream→chat reducer. Shared by React hooks and tests (testable without a renderer).
import type { Interrupt, StreamEvent } from './types.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
  /** P0.1: accumulated thinking trace of a reasoning model (absent for non-reasoning turns). */
  reasoning?: string;
}
export interface ChatState {
  messages: ChatMessage[];
  interrupts: Interrupt[];
  runId?: string;
}
export const initialChatState: ChatState = { messages: [], interrupts: [] };

/** Append a user message + clear pending interrupts (new turn). */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  return { ...state, messages: [...state.messages, { role: 'user', content: text }], interrupts: [] };
}

/** Apply a completed (non-stream) run result: assistant text + interrupts + runId. */
export function applyRunResult(state: ChatState, r: { runId: string; text?: string; interrupts?: Interrupt[] }): ChatState {
  return {
    ...state,
    runId: r.runId,
    messages: r.text ? [...state.messages, { role: 'assistant', content: r.text }] : state.messages,
    interrupts: r.interrupts ?? [],
  };
}

/** Apply a single SSE event to the state (streaming). */
export function applyStreamEvent(state: ChatState, ev: StreamEvent): ChatState {
  switch (ev.event) {
    case 'text-delta': {
      const text = (ev.data as any).text ?? '';
      if (!text) return state;
      const msgs = state.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, content: last.content + text };
      else msgs.push({ role: 'assistant', content: text });
      return { ...state, messages: msgs };
    }
    case 'reasoning-delta': {
      // P0.1: the thinking trace accumulates NEXT TO the answer text (same assistant message,
      // Separate field) — it used to be silently dropped end-to-end for reasoning models.
      const text = (ev.data as any).text ?? '';
      if (!text) return state;
      const msgs = state.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + text };
      else msgs.push({ role: 'assistant', content: '', reasoning: text });
      return { ...state, messages: msgs };
    }
    case 'interrupt':
      return { ...state, interrupts: (ev.data as any).interrupts ?? [] };
    case 'done':
      return { ...state, runId: (ev.data as any).runId ?? state.runId };
    default:
      return state;
  }
}
