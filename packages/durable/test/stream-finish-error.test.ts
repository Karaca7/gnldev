// K1/GOREV W1 (B) — streamFinishError: helper exported so code that consumes streamDurable directly
// (manually reading fullStream, NOT @gnldev/server sse.ts / @gnldev/agui) can convert the blocked/limit
// sentinel into a TYPED error on its own. Uses the SAME scan order as blockedFromSteps/limitBreachFromSteps
// (runDurableInner calls this same function too — the conversion logic lives in one place).
import { describe, it, expect } from 'vitest';
import {
  streamFinishError,
  SideEffectRetryBlockedError,
  RetryLimitExceededError,
  RunBusyError,
  ToolLoopDetectedError,
  RunLimitExceededError,
} from '../src/index.js';

function blockedStep(code: string) {
  return {
    content: [
      {
        type: 'tool-result',
        output: {
          __gnl_blocked: { toolCallId: 'call-1', toolName: 'chargeCard', code, message: `${code} message`, detail: { x: 1 } },
        },
      },
    ],
  };
}

function limitStep(kind: 'loop' | 'maxToolCalls') {
  return {
    content: [
      {
        type: 'tool-result',
        output: { __gnl_limit_exceeded: { kind, message: `${kind} message`, detail: { y: 1 } } },
      },
    ],
  };
}

describe('streamFinishError (K1/GOREV W1 — B)', () => {
  it('__gnl_blocked sentinel (SideEffectRetryBlockedError) → converted to a typed error', () => {
    const err = streamFinishError([blockedStep('SideEffectRetryBlockedError')]);
    expect(err).toBeInstanceOf(SideEffectRetryBlockedError);
    expect(err!.message).toContain('SideEffectRetryBlockedError message');
  });

  it('__gnl_blocked sentinel (RetryLimitExceededError) → converted to a typed error', () => {
    const err = streamFinishError([blockedStep('RetryLimitExceededError')]);
    expect(err).toBeInstanceOf(RetryLimitExceededError);
  });

  it('__gnl_blocked sentinel (unknown code) → falls back to RunBusyError (SAME default as errorFromBlocked)', () => {
    const err = streamFinishError([blockedStep('RunBusyError')]);
    expect(err).toBeInstanceOf(RunBusyError);
  });

  it('__gnl_limit_exceeded (loop) → ToolLoopDetectedError', () => {
    const err = streamFinishError([limitStep('loop')]);
    expect(err).toBeInstanceOf(ToolLoopDetectedError);
  });

  it('__gnl_limit_exceeded (maxToolCalls) → RunLimitExceededError', () => {
    const err = streamFinishError([limitStep('maxToolCalls')]);
    expect(err).toBeInstanceOf(RunLimitExceededError);
  });

  it('the blocked sentinel is scanned BEFORE the limit sentinel (if a step has both, blocked wins)', () => {
    const step = {
      content: [
        ...blockedStep('SideEffectRetryBlockedError').content,
        ...limitStep('loop').content,
      ],
    };
    const err = streamFinishError([step]);
    expect(err).toBeInstanceOf(SideEffectRetryBlockedError);
  });

  it('returns undefined when there is no sentinel — the sentinel itself NEVER leaks out', () => {
    const normalStep = { content: [{ type: 'text', text: 'ok' }] };
    expect(streamFinishError([normalStep])).toBeUndefined();
    expect(streamFinishError([])).toBeUndefined();
    expect(streamFinishError(undefined as any)).toBeUndefined();
  });
});
