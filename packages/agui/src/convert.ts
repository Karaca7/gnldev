// PURE (side-effect-free) converter: converts a single event from the @gnl/server SSE contract
// ({event, data} — text-delta/tool-call/tool-result/error/interrupt/done, see the header comment in
// packages/server/src/sse.ts) into an AG-UI event sequence. State is passed in/returned from OUTSIDE
// (no closed-over mutable state) → the same (gnlEvent, ctx, state) input ALWAYS produces the same
// output — compatible with deterministic replay.
//
// TEXT_MESSAGE_START/END framing of text-deltas is tracked here via state: GNL SSE has NO separate
// "text started/ended" event (only consecutive text-deltas) → START is synthesized on the first delta,
// END is closed when the next non-text event arrives (or on done/error).
import { EventType, type AguiEvent, type RunErrorEvent, type RunFinishedEvent } from './types.js';

/** The SSE frame shape written by @gnl/server's pipeAgentStream (event name + JSON data). */
export interface GnlSseEvent {
  event: 'text-delta' | 'tool-call' | 'tool-result' | 'error' | 'interrupt' | 'done' | string;
  data: any;
}

export interface AguiConvertContext {
  threadId: string;
  runId: string;
}

export interface AguiConvertState {
  /** Whether a text message is currently open (START written, END not yet written). */
  textOpen: boolean;
  /** The id of the open text message (only defined while textOpen). */
  textMessageId?: string;
  /** The sequence number to assign to the next NEW text message (deterministic id: `${runId}:text:${seq}`). */
  textSeq: number;
  /**
   * P0.1: toolCallIds whose START/ARGS were already streamed incrementally via tool-input-* events —
   * when the complete `tool-call` event later arrives for the same id, it must NOT re-frame
   * START/ARGS/END a second time (the UI would show a duplicate call). Optional so existing
   * hand-constructed states keep working (absent = empty).
   */
  streamedToolIds?: string[];
}

export const initialAguiConvertState: AguiConvertState = { textOpen: false, textSeq: 0 };

export interface AguiConvertResult {
  events: AguiEvent[];
  state: AguiConvertState;
}

/** If a text message is open, close it with TEXT_MESSAGE_END (before tool-call/tool-result/interrupt/error/done). */
function closeText(state: AguiConvertState): AguiConvertResult {
  if (!state.textOpen || !state.textMessageId) return { events: [], state };
  return {
    events: [{ type: EventType.TEXT_MESSAGE_END, messageId: state.textMessageId }],
    state: { ...state, textOpen: false, textMessageId: undefined },
  };
}

/**
 * Converts a single GNL SSE event into an AG-UI event sequence.
 * If `state` is not given, it starts fresh (`initialAguiConvertState`) — a single state object must
 * be threaded from start to end for the ENTIRE run (see pipeAguiStream / usage in tests).
 */
export function toAguiEvents(
  gnlEvent: GnlSseEvent,
  ctx: AguiConvertContext,
  state: AguiConvertState = initialAguiConvertState,
): AguiConvertResult {
  switch (gnlEvent.event) {
    case 'text-delta': {
      const text: string = gnlEvent.data?.text ?? '';
      if (state.textOpen && state.textMessageId) {
        return {
          events: [{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: state.textMessageId, delta: text }],
          state,
        };
      }
      const messageId = `${ctx.runId}:text:${state.textSeq}`;
      return {
        events: [
          { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
          { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
        ],
        state: { textOpen: true, textMessageId: messageId, textSeq: state.textSeq + 1 },
      };
    }
    // P0.1: REAL incremental args streaming (the spec's native TOOL_CALL_START→ARGS…→END framing) —
    // the "single delta" simplification below now only applies when no tool-input-* events preceded.
    case 'tool-input-start': {
      const closed = closeText(state);
      const { toolCallId, toolName } = gnlEvent.data ?? {};
      return {
        events: [...closed.events, { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: toolName }],
        state: { ...closed.state, streamedToolIds: [...(closed.state.streamedToolIds ?? []), toolCallId] },
      };
    }
    case 'tool-input-delta': {
      const { toolCallId, delta } = gnlEvent.data ?? {};
      return { events: [{ type: EventType.TOOL_CALL_ARGS, toolCallId, delta: String(delta ?? '') }], state };
    }
    case 'tool-input-end': {
      const { toolCallId } = gnlEvent.data ?? {};
      return { events: [{ type: EventType.TOOL_CALL_END, toolCallId }], state };
    }
    case 'tool-call': {
      const closed = closeText(state);
      const { toolCallId, toolName, input } = gnlEvent.data ?? {};
      // Already framed incrementally via tool-input-* → a second START/ARGS/END would duplicate the call in the UI.
      if (closed.state.streamedToolIds?.includes(toolCallId)) return { events: closed.events, state: closed.state };
      return {
        events: [
          ...closed.events,
          { type: EventType.TOOL_CALL_START, toolCallId, toolCallName: toolName },
          // Deliberate simplification (only on the non-streamed path): GNL's tool-call event gives
          // arguments COMPLETE, so they travel here in a SINGLE delta.
          { type: EventType.TOOL_CALL_ARGS, toolCallId, delta: JSON.stringify(input ?? {}) },
          { type: EventType.TOOL_CALL_END, toolCallId },
        ],
        state: closed.state,
      };
    }
    case 'tool-result': {
      const closed = closeText(state);
      const { toolCallId, output } = gnlEvent.data ?? {};
      return {
        events: [
          ...closed.events,
          {
            type: EventType.TOOL_CALL_RESULT,
            messageId: `${toolCallId}:result`,
            toolCallId,
            content: JSON.stringify(output ?? null),
            role: 'tool',
          },
        ],
        state: closed.state,
      };
    }
    case 'interrupt': {
      // UNCERTAIN: we're not sure whether the AG-UI core subset has a dedicated event type for
      // HITL/suspend (we didn't make one up) → carried into the spec's CUSTOM escape hatch under the name `gnl.interrupt`.
      const closed = closeText(state);
      return {
        events: [...closed.events, { type: EventType.CUSTOM, name: 'gnl.interrupt', value: gnlEvent.data }],
        state: closed.state,
      };
    }
    case 'error': {
      const closed = closeText(state);
      const { error, code, detail } = gnlEvent.data ?? {};
      const evt: RunErrorEvent = { type: EventType.RUN_ERROR, message: String(error ?? 'unknown error') };
      if (code) evt.code = code;
      if (detail !== undefined) evt.rawEvent = detail;
      return { events: [...closed.events, evt], state: closed.state };
    }
    case 'done': {
      const closed = closeText(state);
      const { finishReason, usage } = gnlEvent.data ?? {};
      const evt: RunFinishedEvent = { type: EventType.RUN_FINISHED, threadId: ctx.threadId, runId: ctx.runId };
      if (finishReason !== undefined || usage !== undefined) evt.result = { finishReason, usage };
      return { events: [...closed.events, evt], state: closed.state };
    }
    default:
      // P0.1: NO silent drop — every GNL event without a native AG-UI mapping (reasoning-*/source/
      // file/step-*/tool-error/raw and anything future) travels through the spec's CUSTOM escape hatch
      // as `gnl.<event>` (the same pattern `gnl.interrupt` above already established). Deliberately
      // does NOT close an open text frame: these are out-of-band annotations, not message boundaries.
      return { events: [{ type: EventType.CUSTOM, name: `gnl.${gnlEvent.event}`, value: gnlEvent.data }], state };
  }
}
