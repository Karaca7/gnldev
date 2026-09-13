// The three internal sentinels durable-tool.ts returns as a tool's `output` must never reach a
// browser useChat client verbatim — they carry `detail` and raw guard reasons, which are an internal
// API rather than a wire contract.
//
// Two of the three had no test at all. `chat-route.test.ts` asserted that none of them appears in the
// response body, but its scenario only ever produces `__gnl_suspend`, so the assertions for
// `__gnl_blocked` and `__gnl_limit_exceeded` were true about a string that was never in the stream.
// Measured: deleting both masking branches from `sentinel-mask.ts` left all 11 tests green.
//
// This covers the shared choke point directly — ui-stream.ts (live) and messages.ts (history) both
// route through it, so a branch that survives here cannot be dropped unnoticed on either path.
import { describe, it, expect } from 'vitest';
import { maskSentinelOutput } from '../src/index.js';

describe('maskSentinelOutput', () => {
  it('masks __gnl_suspend into a pending-approval shape and hands back the raw interrupt', () => {
    const interrupt = { toolCallId: 'c1', toolName: 'chargeCard', args: { amount: 5000 }, reason: 'needs approval' };
    const { display, interrupts, interrupt: out } = maskSentinelOutput({ __gnl_suspend: interrupt });
    expect(display).toEqual({ pending: 'approval', toolName: 'chargeCard', reason: 'needs approval' });
    expect(JSON.stringify(display)).not.toContain('__gnl_suspend');
    // The caller needs the raw interrupt to emit a data-gnl-interrupt chunk; it just must not be the
    // value shown in place of the tool output.
    expect(interrupts).toEqual([interrupt]);
    expect(interrupts![0]).toBe(interrupt); // an ordinary suspend is passed through, not rebuilt
    expect(out).toBe(interrupt); // deprecated single — still the same object for existing readers
  });

  // A proxy suspend carries the parent's toolCallId, and answering THAT id is a documented no-op in
  // the engine. The unwrap is `surfacedInterrupts`', not this file's — what is asserted here is that
  // the helper asks for it at all, and hands back every question rather than the first.
  it('nested suspend: surfaces the child questions, and the deprecated single is only the first of them', () => {
    const { display, interrupts, interrupt } = maskSentinelOutput({
      __gnl_suspend: {
        toolCallId: 'parent-1', toolName: 'agent', args: { task: 't' }, kind: 'nested', reason: 'a sub-agent stopped',
        nested: {
          runId: 'agent:parent-1',
          interrupts: [
            { toolCallId: 'child-a', toolName: 'chargeCard', args: { amount: 5000 }, reason: 'large amount' },
            { toolCallId: 'child-b', toolName: 'wire', args: { iban: 'X' } },
          ],
        },
      },
    });
    expect(interrupts!.map((i) => i.toolCallId)).toEqual(['child-a', 'child-b']);
    expect(interrupt!.toolCallId).toBe('child-a'); // and this is exactly why reading it is deprecated
    // The tool output placeholder still belongs to the suspended (parent) call.
    expect(display).toMatchObject({ pending: 'approval', toolName: 'agent' });
  });

  it('masks __gnl_limit_exceeded, keeping code/message and dropping everything else', () => {
    const { display, interrupt } = maskSentinelOutput({
      __gnl_limit_exceeded: { kind: 'tool_loop', message: 'too many calls', detail: { seenArgs: 'INTERNAL' } },
    });
    expect(display).toEqual({ blocked: true, code: 'tool_loop', message: 'too many calls' });
    // `detail` is the internal half — a name-only copy would have carried it straight through.
    expect(JSON.stringify(display)).not.toContain('INTERNAL');
    expect(JSON.stringify(display)).not.toContain('__gnl_limit_exceeded');
    expect(interrupt).toBeUndefined();
  });

  it('masks __gnl_blocked the same way', () => {
    const { display, interrupt } = maskSentinelOutput({
      __gnl_blocked: { code: 'side_effect_retry_blocked', message: 'refused', detail: { rawGuardReason: 'INTERNAL' } },
    });
    expect(display).toEqual({ blocked: true, code: 'side_effect_retry_blocked', message: 'refused' });
    expect(JSON.stringify(display)).not.toContain('INTERNAL');
    expect(JSON.stringify(display)).not.toContain('__gnl_blocked');
    expect(interrupt).toBeUndefined();
  });

  it('backfills toolName from the hint only when the sentinel does not carry its own', () => {
    // Older journal records stored a suspend sentinel without `toolName`.
    const noName = maskSentinelOutput({ __gnl_suspend: { toolCallId: 'c1', reason: 'r' } }, 'fromHint');
    expect((noName.display as any).toolName).toBe('fromHint');
    // A sentinel that names itself wins — the hint is a fallback, not an override.
    const named = maskSentinelOutput({ __gnl_suspend: { toolCallId: 'c1', toolName: 'ownName', reason: 'r' } }, 'fromHint');
    expect((named.display as any).toolName).toBe('ownName');
  });

  it('passes ordinary tool output through by identity, not by copy', () => {
    const output = { paid: true, receipt: { id: 'r1' } };
    const { display, interrupt } = maskSentinelOutput(output);
    // ui-stream.ts decides whether to rewrite the chunk with `display !== chunk.output`, so a
    // defensive clone here would rewrite every chunk and make the masking indistinguishable from a
    // pass-through.
    expect(display).toBe(output);
    expect(interrupt).toBeUndefined();
  });

  it('leaves values that cannot carry a sentinel alone', () => {
    for (const v of [null, undefined, 'a string', 42, ['an', 'array']]) {
      expect(maskSentinelOutput(v).display).toBe(v);
    }
  });
});
