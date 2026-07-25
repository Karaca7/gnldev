// toAguiEvents unit tests: each GNL SSE event type → expected AG-UI event sequence (PURE conversion,
// no I/O). State is manually threaded across runs (see convert.ts header note).
import { describe, it, expect } from 'vitest';
import { toAguiEvents, initialAguiConvertState, type AguiConvertState } from '../src/convert.js';
import { EventType } from '../src/types.js';

const ctx = { threadId: 't1', runId: 'r1' };

describe('@gnldev/agui toAguiEvents', () => {
  it('text-delta (first) → TEXT_MESSAGE_START + TEXT_MESSAGE_CONTENT, state becomes textOpen', () => {
    const { events, state } = toAguiEvents({ event: 'text-delta', data: { text: 'Hello ' } }, ctx);
    expect(events).toEqual([
      { type: EventType.TEXT_MESSAGE_START, messageId: 'r1:text:0', role: 'assistant' },
      { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'r1:text:0', delta: 'Hello ' },
    ]);
    expect(state.textOpen).toBe(true);
    expect(state.textMessageId).toBe('r1:text:0');
  });

  it('text-delta (subsequent, same state) → only TEXT_MESSAGE_CONTENT, START not repeated', () => {
    const first = toAguiEvents({ event: 'text-delta', data: { text: 'Hello ' } }, ctx);
    const second = toAguiEvents({ event: 'text-delta', data: { text: 'world' } }, ctx, first.state);
    expect(second.events).toEqual([{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'r1:text:0', delta: 'world' }]);
    expect(second.state.textMessageId).toBe('r1:text:0');
  });

  it('tool-call → TOOL_CALL_START/ARGS/END (if text is open, TEXT_MESSAGE_END first)', () => {
    const afterText = toAguiEvents({ event: 'text-delta', data: { text: 'hi' } }, ctx).state;
    const { events, state } = toAguiEvents(
      { event: 'tool-call', data: { toolCallId: 'call-1', toolName: 'search', input: { q: 'x' } } },
      ctx,
      afterText,
    );
    expect(events).toEqual([
      { type: EventType.TEXT_MESSAGE_END, messageId: 'r1:text:0' },
      { type: EventType.TOOL_CALL_START, toolCallId: 'call-1', toolCallName: 'search' },
      { type: EventType.TOOL_CALL_ARGS, toolCallId: 'call-1', delta: JSON.stringify({ q: 'x' }) },
      { type: EventType.TOOL_CALL_END, toolCallId: 'call-1' },
    ]);
    expect(state.textOpen).toBe(false);
  });

  it('tool-call while text is not open → starts without an END event', () => {
    const { events } = toAguiEvents(
      { event: 'tool-call', data: { toolCallId: 'call-2', toolName: 'search', input: {} } },
      ctx,
      initialAguiConvertState,
    );
    expect(events[0]).toEqual({ type: EventType.TOOL_CALL_START, toolCallId: 'call-2', toolCallName: 'search' });
  });

  it('tool-result → TOOL_CALL_RESULT (messageId = toolCallId:result)', () => {
    const { events } = toAguiEvents(
      { event: 'tool-result', data: { toolCallId: 'call-1', toolName: 'search', output: { hits: 3 } } },
      ctx,
      initialAguiConvertState,
    );
    expect(events).toEqual([
      {
        type: EventType.TOOL_CALL_RESULT,
        messageId: 'call-1:result',
        toolCallId: 'call-1',
        content: JSON.stringify({ hits: 3 }),
        role: 'tool',
      },
    ]);
  });

  it('error → RUN_ERROR (code is carried, detail goes to rawEvent)', () => {
    const { events } = toAguiEvents(
      { event: 'error', data: { error: 'boom', code: 'tool_loop_detected', detail: { toolName: 'x' } } },
      ctx,
      initialAguiConvertState,
    );
    expect(events).toEqual([
      { type: EventType.RUN_ERROR, message: 'boom', code: 'tool_loop_detected', rawEvent: { toolName: 'x' } },
    ]);
  });

  it('error while text is open → TEXT_MESSAGE_END first, then RUN_ERROR', () => {
    const afterText = toAguiEvents({ event: 'text-delta', data: { text: 'hi' } }, ctx).state;
    const { events } = toAguiEvents({ event: 'error', data: { error: 'boom' } }, ctx, afterText);
    expect(events[0].type).toBe(EventType.TEXT_MESSAGE_END);
    expect(events[1]).toEqual({ type: EventType.RUN_ERROR, message: 'boom' });
  });

  it('interrupt → CUSTOM event (gnl.interrupt) — UNCERTAIN mapping, see README/uncertainties', () => {
    const interrupts = [{ toolCallId: 'c1', toolName: 'charge', args: {} }];
    const { events } = toAguiEvents({ event: 'interrupt', data: { interrupts } }, ctx, initialAguiConvertState);
    expect(events).toEqual([{ type: EventType.CUSTOM, name: 'gnl.interrupt', value: { interrupts } }]);
  });

  it('done → RUN_FINISHED (threadId/runId come from ctx, if text is open it closes first)', () => {
    const afterText = toAguiEvents({ event: 'text-delta', data: { text: 'hi' } }, ctx).state;
    const { events } = toAguiEvents({ event: 'done', data: { runId: 'r1', finishReason: 'stop', usage: { totalTokens: 5 } } }, ctx, afterText);
    expect(events[0].type).toBe(EventType.TEXT_MESSAGE_END);
    expect(events[1]).toEqual({
      type: EventType.RUN_FINISHED,
      threadId: 't1',
      runId: 'r1',
      result: { finishReason: 'stop', usage: { totalTokens: 5 } },
    });
  });

  // P0.1: unknown GNL events used to be SILENTLY DROPPED by the converter's default case.
  it('P0.1: unmapped GNL events travel through CUSTOM as gnl.<event> (no silent drop)', () => {
    for (const [event, data] of [
      ['reasoning-delta', { id: 'rs1', text: 'thinking' }],
      ['source', { sourceType: 'url', url: 'https://x' }],
      ['file', { mediaType: 'image/png', base64: 'AQID' }],
      ['step-finish', { finishReason: 'stop' }],
      ['tool-error', { toolCallId: 'c9', toolName: 't', error: 'boom' }],
      ['raw', { type: 'future-part' }],
    ] as const) {
      const out = toAguiEvents({ event, data }, ctx, initialAguiConvertState);
      expect(out.events).toEqual([{ type: EventType.CUSTOM, name: `gnl.${event}`, value: data }]);
    }
  });

  it('P0.1: tool-input-* streams REAL incremental args and the later tool-call does not re-frame', () => {
    const seq: { event: string; data: any }[] = [
      { event: 'tool-input-start', data: { toolCallId: 'c1', toolName: 'search' } },
      { event: 'tool-input-delta', data: { toolCallId: 'c1', delta: '{"q":' } },
      { event: 'tool-input-delta', data: { toolCallId: 'c1', delta: '"x"}' } },
      { event: 'tool-input-end', data: { toolCallId: 'c1' } },
      { event: 'tool-call', data: { toolCallId: 'c1', toolName: 'search', input: { q: 'x' } } }, // complete event follows — must NOT duplicate
      { event: 'tool-result', data: { toolCallId: 'c1', toolName: 'search', output: { ok: true } } },
    ];
    let state: AguiConvertState = initialAguiConvertState;
    const all: any[] = [];
    for (const gnlEvent of seq) {
      const out = toAguiEvents(gnlEvent, ctx, state);
      state = out.state;
      all.push(...out.events);
    }
    expect(all.map((e) => e.type)).toEqual([
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT, // tool-call re-framed NOTHING — only the result follows
    ]);
    expect(all.filter((e) => e.type === EventType.TOOL_CALL_ARGS).map((e) => e.delta).join('')).toBe('{"q":"x"}');
  });

  it('P0.1: a tool-call WITHOUT preceding tool-input-* still frames the legacy single-delta form', () => {
    const out = toAguiEvents({ event: 'tool-call', data: { toolCallId: 'c2', toolName: 't', input: { a: 1 } } }, ctx, initialAguiConvertState);
    expect(out.events.map((e: any) => e.type)).toEqual([EventType.TOOL_CALL_START, EventType.TOOL_CALL_ARGS, EventType.TOOL_CALL_END]);
  });

  it('a full run sequence produces a deterministic state flow from start to end', () => {
    const seq: { event: string; data: any }[] = [
      { event: 'text-delta', data: { text: 'A' } },
      { event: 'text-delta', data: { text: 'B' } },
      { event: 'tool-call', data: { toolCallId: 'c1', toolName: 't', input: {} } },
      { event: 'tool-result', data: { toolCallId: 'c1', toolName: 't', output: { ok: true } } },
      { event: 'done', data: { runId: 'r1', finishReason: 'stop', usage: undefined } },
    ];
    let state: AguiConvertState = initialAguiConvertState;
    const all: any[] = [];
    for (const gnlEvent of seq) {
      const out = toAguiEvents(gnlEvent, ctx, state);
      state = out.state;
      all.push(...out.events);
    }
    expect(all.map((e) => e.type)).toEqual([
      EventType.TEXT_MESSAGE_START,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_CONTENT,
      EventType.TEXT_MESSAGE_END,
      EventType.TOOL_CALL_START,
      EventType.TOOL_CALL_ARGS,
      EventType.TOOL_CALL_END,
      EventType.TOOL_CALL_RESULT,
      EventType.RUN_FINISHED,
    ]);
  });
});
