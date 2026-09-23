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
  /** Replay-disclosure zarfı (done frame'inden): bu turda journal'dan cevaplanan araç çağrıları —
   *  UI rozeti için makine-okur veri; model kanalına asla girmez. */
  replayedToolCalls?: Array<{ toolCallId: string; toolName?: string; status: string; origin: 'self' | 'window' }>;
  /**
   * Tools that FAILED during this turn. The server emits `tool-error` (server/src/sse.ts:183) and it
   * used to land in `default: return state` — the turn's text was shown and the failure left no trace,
   * so "I cancelled your order" could sit above a `cancelOrder` that answered 503.
   *
   * `tool-error` is NON-terminal: the loop continues and usually produces text, which is exactly why
   * dropping it is worse than dropping a fatal `error` — there is a confident answer to believe. Both
   * sibling surfaces already decided this: @gnldev/studio-ui renders the tool card as failed, and
   * @gnldev/agui forwards it through the AG-UI CUSTOM escape hatch ("NO silent drop"). This is the
   * same decision for the React surface.
   *
   * Cleared at the START of a turn rather than at its end, and that asymmetry with
   * `replayedToolCalls` is deliberate: the envelope is FILLED by `applyRunResult` and only ever
   * cleared by the stream, so clearing it on `done` is safe there. This field is filled BY the
   * stream, so clearing it on `done` would erase the failure the moment the turn that produced it
   * finished. `startTurn` below is the one edge that is always crossed — `appendUserMessage` is not,
   * because the hook only calls it when `input.prompt` is set and a `messages`-driven turn is legal.
   * Measured before that was split out: five `{messages}` turns accumulated five badges.
   */
  toolErrors?: Array<{ toolCallId: string; toolName?: string; error: string }>;
}
export const initialChatState: ChatState = { messages: [], interrupts: [] };

/**
 * The start of a turn, independent of how the caller phrased it. `appendUserMessage` covers the
 * `{prompt}` shape; a `{messages}` run has no text to append but is just as much a new turn, and
 * per-turn state has to be dropped on both.
 */
export function startTurn(state: ChatState): ChatState {
  return { ...state, interrupts: [], replayedToolCalls: undefined, toolErrors: undefined };
}

/** Append a user message + clear pending interrupts (new turn). */
export function appendUserMessage(state: ChatState, text: string): ChatState {
  // replayedToolCalls da YENİ TURDA SİLİNİR (denetçi K12): rozet "bu turun" beyanıdır — taze turda
  // önceki turun "journal'dan geldi" rozeti kalırsa dürüstlük özelliğinin kendisi yanlış-pozitif üretir.
  return { ...startTurn(state), messages: [...state.messages, { role: 'user', content: text }] };
}

/** Apply a completed (non-stream) run result: assistant text + interrupts + runId. */
export function applyRunResult(state: ChatState, r: { runId: string; text?: string; interrupts?: Interrupt[]; replayedToolCalls?: ChatState['replayedToolCalls'] }): ChatState {
  return {
    ...state,
    runId: r.runId,
    messages: r.text ? [...state.messages, { role: 'assistant', content: r.text }] : state.messages,
    interrupts: r.interrupts ?? [],
    // K28 paritesi: zarf run() yüzeyinden de state'e iner; alan gelmediyse SİLİNİR (bayat rozet yasağı).
    replayedToolCalls: r.replayedToolCalls?.length ? r.replayedToolCalls : undefined,
    // A non-streaming run never sees `tool-error` (no SSE), so anything still here belongs to an
    // earlier turn. Same stale-badge rule as the line above.
    toolErrors: undefined,
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
      // separate field) — it used to be silently dropped end-to-end for reasoning models.
      const text = (ev.data as any).text ?? '';
      if (!text) return state;
      const msgs = state.messages.slice();
      const last = msgs[msgs.length - 1];
      if (last && last.role === 'assistant') msgs[msgs.length - 1] = { ...last, reasoning: (last.reasoning ?? '') + text };
      else msgs.push({ role: 'assistant', content: '', reasoning: text });
      return { ...state, messages: msgs };
    }
    case 'tool-error': {
      const d = ev.data as { toolCallId?: string; toolName?: string; error?: unknown };
      return { ...state, toolErrors: [...(state.toolErrors ?? []), {
        toolCallId: String(d?.toolCallId ?? ''), toolName: d?.toolName, error: String(d?.error ?? 'tool failed'),
      }] };
    }
    case 'interrupt':
      return { ...state, interrupts: (ev.data as any).interrupts ?? [] };
    case 'done':
      // Zarf SSE'den GELMEZ (server determinizm pini) — stream turu alanı yalnız TEMİZLER;
      // dolduran tek yüzey run() cevabıdır (applyRunResult).
      return { ...state, runId: (ev.data as any).runId ?? state.runId, replayedToolCalls: undefined };
    default:
      return state;
  }
}
