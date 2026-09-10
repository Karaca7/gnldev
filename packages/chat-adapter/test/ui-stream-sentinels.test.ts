// The LIVE stream path, which the history path's tests do not reach.
//
// `maskSentinelChunks` is a TransformStream with logic of its own — a toolCallId→toolName map, a
// `display !== chunk.output` identity check, and an appended `data-gnl-interrupt` chunk — and the only
// test that drove it went through `createChatRoute`, whose scenario produces `__gnl_suspend` and
// nothing else. Measured: rewriting the transform so that ONLY suspend is masked left all 30 tests
// green while `__gnl_blocked` and `__gnl_limit_exceeded` went to the browser verbatim, `detail` and
// all. That is the same gap the shared helper's tests closed, one layer up.
//
// Driven directly here rather than through a route: the transform only needs a `toUIMessageStream`,
// so the chunks under test can be produced exactly, including the ones a scripted agent run will not
// emit on demand.
import { describe, it, expect } from 'vitest';
import { toUIMessageStream } from '../src/index.js';

/** The minimum `toUIMessageStream` accepts — a source of chunks, which is all the transform reads. */
function chunkSource(chunks: unknown[]) {
  return {
    toUIMessageStream: () =>
      new ReadableStream({
        start(c) {
          for (const chunk of chunks) c.enqueue(chunk);
          c.close();
        },
      }) as any,
  };
}

async function drain(chunks: unknown[], runId?: string): Promise<any[]> {
  const out: any[] = [];
  for await (const c of toUIMessageStream(chunkSource(chunks) as any, runId ? { runId } : undefined)) out.push(c);
  return out;
}

describe('live stream sentinel masking', () => {
  it('masks __gnl_blocked, and its internal detail never reaches the wire', async () => {
    const out = await drain([
      { type: 'tool-input-start', toolCallId: 'c1', toolName: 'chargeCard' },
      {
        type: 'tool-output-available',
        toolCallId: 'c1',
        output: { __gnl_blocked: { code: 'side_effect_retry_blocked', message: 'refused', detail: { raw: 'INTERNAL' } } },
      },
    ]);
    const result = out.find((c) => c.type === 'tool-output-available');
    expect(result.output).toEqual({ blocked: true, code: 'side_effect_retry_blocked', message: 'refused' });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('__gnl_blocked');
    expect(wire, 'detail is an internal API, not a wire contract').not.toContain('INTERNAL');
    // Only a suspend carries an interrupt for the client to act on.
    expect(out.some((c) => c.type === 'data-gnl-interrupt')).toBe(false);
  });

  it('masks __gnl_limit_exceeded the same way', async () => {
    const out = await drain([
      { type: 'tool-input-start', toolCallId: 'c2', toolName: 'search' },
      {
        type: 'tool-output-available',
        toolCallId: 'c2',
        output: { __gnl_limit_exceeded: { kind: 'tool_loop', message: 'too many calls', detail: { seen: 'INTERNAL' } } },
      },
    ]);
    expect(out.find((c) => c.type === 'tool-output-available').output)
      .toEqual({ blocked: true, code: 'tool_loop', message: 'too many calls' });
    const wire = JSON.stringify(out);
    expect(wire).not.toContain('__gnl_limit_exceeded');
    expect(wire).not.toContain('INTERNAL');
  });

  it('masks __gnl_suspend and appends the interrupt chunk right after it', async () => {
    const interrupt = { toolCallId: 'c3', toolName: 'chargeCard', args: { amount: 5000 }, reason: 'needs approval' };
    const out = await drain([
      { type: 'tool-input-start', toolCallId: 'c3', toolName: 'chargeCard' },
      { type: 'tool-output-available', toolCallId: 'c3', output: { __gnl_suspend: interrupt } },
    ]);
    const at = out.findIndex((c) => c.type === 'tool-output-available');
    expect(out[at].output).toEqual({ pending: 'approval', toolName: 'chargeCard', reason: 'needs approval' });
    expect(out[at + 1], 'the interrupt must follow the chunk it belongs to').toMatchObject({
      type: 'data-gnl-interrupt',
      data: { interrupts: [interrupt] },
    });
    expect(JSON.stringify(out[at])).not.toContain('__gnl_suspend');
  });

  // `tool-output-available` carries only a toolCallId, so the name comes from the earlier input chunk.
  // Neutering that map left every test green, while a suspend sentinel with no toolName of its own
  // Reported `toolName: undefined` to the client.
  it('carries the tool name across from the input chunk when the sentinel lacks one', async () => {
    const out = await drain([
      { type: 'tool-input-start', toolCallId: 'c4', toolName: 'fromInputChunk' },
      { type: 'tool-output-available', toolCallId: 'c4', output: { __gnl_suspend: { toolCallId: 'c4', reason: 'r' } } },
    ]);
    expect(out.find((c) => c.type === 'tool-output-available').output.toolName).toBe('fromInputChunk');
  });

  // THE FOURTH SURFACE. server/sse, studio/sse and Studio's approval inbox all learned to unwrap a
  // proxy suspend; this one — the useChat channel, which is where an end user actually sits — was
  // still handing over the parent's toolCallId, and one at a time. A client following the documented
  // contract (`approvals[interrupt.toolCallId] = true`) approved an id the engine deliberately
  // ignores, so nothing moved; and a parent standing in for TWO child questions could not have been
  // answered by that chunk shape at all, however the client behaved.
  it('nested suspend: the interrupt chunk carries the CHILD toolCallIds, not the parent proxy', async () => {
    const out = await drain([
      { type: 'tool-input-start', toolCallId: 'parent-1', toolName: 'agent' },
      {
        type: 'tool-output-available',
        toolCallId: 'parent-1',
        output: {
          __gnl_suspend: {
            toolCallId: 'parent-1',
            toolName: 'agent',
            args: { task: 'settle the invoice' },
            kind: 'nested',
            reason: 'A delegated sub-agent stopped for a human: needs approval (nested run \'agent:parent-1\', 2 pending).',
            nested: {
              runId: 'agent:parent-1',
              interrupts: [
                { toolCallId: 'child-a', toolName: 'chargeCard', args: { amount: 5000 }, reason: 'large amount' },
                { toolCallId: 'child-b', toolName: 'wire', args: { iban: 'X' }, reason: 'needs approval' },
              ],
            },
          },
        },
      },
    ]);

    const chunk = out.find((c) => c.type === 'data-gnl-interrupt');
    expect(chunk.data.interrupts.map((i: any) => i.toolCallId)).toEqual(['child-a', 'child-b']);
    expect(chunk.data.interrupts.map((i: any) => i.toolName)).toEqual(['chargeCard', 'wire']);
    expect(chunk.data.interrupts[0].args).toEqual({ amount: 5000 });
    // Both questions reach the browser or neither is answerable: dropping the tail would leave the
    // run suspended after the user approved everything they were shown.
    expect(chunk.data.interrupts).toHaveLength(2);
    // The proxy id is not an approval address — it must not be offered as one.
    expect(chunk.data.interrupts.some((i: any) => i.toolCallId === 'parent-1')).toBe(false);
    // The masked output still describes THIS chunk's tool (the parent), which is whose result it is.
    expect(out.find((c) => c.type === 'tool-output-available').output).toMatchObject({ pending: 'approval', toolName: 'agent' });
  });

  // The approval ADDRESS (FAZ-2) belongs on every entry, not on whichever one happens to be first —
  // an interrupt without it sends the client's re-POST to a freshly-derived runId, and the suspended
  // run waits forever.
  it('the runId stamp lands on EVERY surfaced interrupt', async () => {
    const out = await drain([
      { type: 'tool-input-start', toolCallId: 'parent-2', toolName: 'agent' },
      {
        type: 'tool-output-available',
        toolCallId: 'parent-2',
        output: {
          __gnl_suspend: {
            toolCallId: 'parent-2', toolName: 'agent', args: {}, kind: 'nested',
            nested: {
              runId: 'agent:parent-2',
              interrupts: [
                { toolCallId: 'child-a', toolName: 'chargeCard', args: {} },
                { toolCallId: 'child-b', toolName: 'wire', args: {} },
              ],
            },
          },
        },
      },
    ], 'run-77');
    const entries = out.find((c) => c.type === 'data-gnl-interrupt').data.interrupts;
    expect(entries.map((i: any) => i.runId)).toEqual(['run-77', 'run-77']);
  });

  it('an ordinary suspend is a one-element list carrying exactly what it always carried', async () => {
    const interrupt = { toolCallId: 'c6', toolName: 'chargeCard', args: { amount: 5000 }, reason: 'large amount' };
    const out = await drain([
      { type: 'tool-input-start', toolCallId: 'c6', toolName: 'chargeCard' },
      { type: 'tool-output-available', toolCallId: 'c6', output: { __gnl_suspend: interrupt } },
    ]);
    expect(out.find((c) => c.type === 'data-gnl-interrupt').data.interrupts).toEqual([interrupt]);
  });

  it('leaves ordinary tool output untouched, and passes other chunk types through', async () => {
    const out = await drain([
      { type: 'text-delta', id: 't1', delta: 'hello' },
      { type: 'tool-input-start', toolCallId: 'c5', toolName: 'pay' },
      { type: 'tool-output-available', toolCallId: 'c5', output: { paid: true } },
    ]);
    expect(out.find((c) => c.type === 'tool-output-available').output).toEqual({ paid: true });
    expect(out.find((c) => c.type === 'text-delta')).toMatchObject({ delta: 'hello' });
    expect(out).toHaveLength(3); // nothing added, nothing dropped
  });
});
