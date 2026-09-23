// AUDIT FINDINGS — rounds 11-12 (audit-log.md).
//
// #23 — `tool-error` left no trace in the chat state. Two sibling surfaces had already found this
// and fixed it:
//   studio-ui/src/api.ts:820  "an event it cannot even name is an accident waiting to happen"
//   agui/src/convert.ts:159   "P0.1: NO silent drop"
// The published SDK was the only one still losing it, and `useChat` is the FIRST example in this
// package's README (lines 42-46).
import { describe, it, expect } from 'vitest';
import { applyStreamEvent, applyRunResult, appendUserMessage, startTurn, initialChatState } from '../src/accumulator.js';

const toolError = { event: 'tool-error', data: { toolCallId: 'c1', toolName: 'cancelOrder', error: 'payment gateway 503' } } as any;

describe('#23 a failed tool call must leave a trace in the UI state', () => {
  const afterText = () => applyStreamEvent(initialChatState,
    { event: 'text-delta', data: { text: 'I cancelled your order.' } } as any);

  it('tool-error changes the state', () => {
    const before = afterText();
    const after = applyStreamEvent(before, toolError);
    expect(JSON.stringify(after),
      'the user reads "I cancelled your order" while cancelOrder answered 503').not.toBe(JSON.stringify(before));
  });

  it('the failure itself is reachable from the state', () => {
    const s = applyStreamEvent(afterText(), toolError);
    expect(JSON.stringify(s)).toContain('cancelOrder');
    expect(JSON.stringify(s)).toContain('503');
  });

  it('CONTROL: the events that were already handled still are', () => {
    const s = afterText();
    expect((s.messages.at(-1) as any).content).toBe('I cancelled your order.');
    const i = applyStreamEvent(s, { event: 'interrupt', data: { interrupts: [{ toolCallId: 'x' }] } } as any);
    expect(i.interrupts.length).toBe(1);
  });
});

// A failure badge that outlives the turn that produced it is a lie of the same family as dropping
// it — the comment on the field says so. `appendUserMessage` is NOT the turn boundary: the hook only
// calls it when `input.prompt` is set, and a `{messages}` turn is legal (types.ts RunInput).
describe('#23b toolErrors must not survive into the next turn', () => {
  const failed = (s: typeof initialChatState) => applyStreamEvent(s,
    { event: 'tool-error', data: { toolCallId: 'c1', toolName: 'charge', error: '503' } } as any);

  it('a {prompt} turn clears the previous turn', () => {
    const after = appendUserMessage(failed(initialChatState), 'next question');
    expect(after.toolErrors ?? []).toEqual([]);
  });

  it('a {messages} turn clears it too — that is the path the hook takes without a prompt', () => {
    const after = startTurn(failed(initialChatState));
    expect(after.toolErrors ?? [], 'measured before this: five turns accumulated five badges').toEqual([]);
  });

  it('five consecutive {messages} turns do not accumulate', () => {
    let s = initialChatState;
    for (let i = 0; i < 5; i++) s = failed(startTurn(s));
    expect(s.toolErrors?.length).toBe(1);
  });

  it('a non-streaming run() result clears it (no SSE, so nothing here is current)', () => {
    const after = applyRunResult(failed(initialChatState), { runId: 'r1', text: 'ok' });
    expect(after.toolErrors ?? []).toEqual([]);
  });

  it('CONTROL: within ONE turn the failures accumulate and survive', () => {
    let s = startTurn(initialChatState);
    s = failed(s);
    s = applyStreamEvent(s, { event: 'text-delta', data: { text: 'done' } } as any);
    expect(s.toolErrors?.length, 'a resumed stream continues the SAME turn').toBe(1);
  });
});
