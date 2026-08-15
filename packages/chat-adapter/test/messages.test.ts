// toUIMessages: journal entries (+ optional seed, mirroring reconstructState's own fabrication pattern
// from packages/durable/test/time-travel.test.ts) → useChat-compatible UIMessage[].
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '@gnldev/durable';
import { toUIMessages } from '../src/index.js';

describe('@gnldev/chat-adapter toUIMessages', () => {
  it('maps [user, assistant(tool output-available), assistant(text)] from journal entries + seed', async () => {
    const j = new InMemoryJournal();
    await j.put(runKeys.model('r1', 0), {
      content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'pay', input: '{"amount":10}' }],
      finishReason: 'tool-calls',
    });
    await j.put(runKeys.tool('r1', 'c1'), { status: 'succeeded', output: { paid: true } });
    await j.put(runKeys.model('r1', 1), { content: [{ type: 'text', text: 'done' }], finishReason: 'stop' });
    const entries = await j.readRun('r1');

    const msgs = toUIMessages(entries, { seed: { prompt: 'pay please' }, runId: 'r1' });
    expect(msgs).toHaveLength(3); // seed user + assistant(tool-call) + assistant(text) — the 'tool' journal
    // entry is merged into the assistant message's tool part, not emitted as its own UIMessage.

    expect(msgs[0].role).toBe('user');
    expect(msgs[0].parts[0]).toMatchObject({ type: 'text', text: 'pay please' });

    expect(msgs[1].role).toBe('assistant');
    const toolPart = (msgs[1].parts as any[]).find((p) => p.type === 'tool-pay');
    expect(toolPart).toMatchObject({ toolCallId: 'c1', state: 'output-available', input: { amount: 10 }, output: { paid: true } });

    expect(msgs[2].role).toBe('assistant');
    expect(msgs[2].parts[0]).toMatchObject({ type: 'text', text: 'done' });

    // Deterministic ids, prefixed with the given runId.
    expect(msgs[0].id).toBe('r1:msg:0');
  });

  it('sentinel-masks a SUSPENDED tool in history (no __gnl_suspend leak; pending-approval shape)', async () => {
    const j = new InMemoryJournal();
    await j.put(runKeys.model('r2', 0), {
      content: [{ type: 'tool-call', toolCallId: 'c2', toolName: 'chargeCard', input: '{"amount":5000}' }],
      finishReason: 'tool-calls',
    });
    await j.put(runKeys.tool('r2', 'c2'), {
      status: 'suspended',
      output: { __gnl_suspend: { toolCallId: 'c2', toolName: 'chargeCard', args: { amount: 5000 }, reason: 'needs approval' } },
    });
    const entries = await j.readRun('r2');

    const msgs = toUIMessages(entries, { runId: 'r2' });
    expect(msgs).toHaveLength(1); // only the assistant message (no seed, no separate tool message)
    expect(msgs[0].role).toBe('assistant');
    const toolPart = (msgs[0].parts as any[]).find((p) => p.type === 'tool-chargeCard');
    expect(toolPart.state).toBe('output-available');
    expect(toolPart.output).toMatchObject({ pending: 'approval', toolName: 'chargeCard', reason: 'needs approval' });
    expect(JSON.stringify(msgs)).not.toContain('__gnl_suspend');
  });

  it('a tool-call with no journaled result yet is state input-available (not output-available)', async () => {
    const j = new InMemoryJournal();
    await j.put(runKeys.model('r3', 0), {
      content: [{ type: 'tool-call', toolCallId: 'c3', toolName: 'lookup', input: '{"q":"x"}' }],
      finishReason: 'tool-calls',
    });
    const entries = await j.readRun('r3');
    const msgs = toUIMessages(entries, { runId: 'r3' });
    const toolPart = (msgs[0].parts as any[]).find((p) => p.type === 'tool-lookup');
    expect(toolPart.state).toBe('input-available');
    expect(toolPart.output).toBeUndefined();
  });

  it('handles STREAMED journal entries ({parts, rest} shape) — text + reasoning accumulate correctly', async () => {
    const j = new InMemoryJournal();
    await j.put(runKeys.model('r4', 0), {
      parts: [
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'rs' },
        { type: 'reasoning-delta', id: 'rs', delta: 'thinking ' },
        { type: 'reasoning-delta', id: 'rs', delta: 'more' },
        { type: 'reasoning-end', id: 'rs' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Hello ' },
        { type: 'text-delta', id: 't1', delta: 'world' },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: 'stop', usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
      ],
      rest: { finishReason: 'stop' },
    });
    const entries = await j.readRun('r4');
    const msgs = toUIMessages(entries, { runId: 'r4' });
    expect(msgs).toHaveLength(1);
    const reasoningPart = (msgs[0].parts as any[]).find((p) => p.type === 'reasoning');
    expect(reasoningPart.text).toBe('thinking more');
    const textPart = (msgs[0].parts as any[]).find((p) => p.type === 'text');
    expect(textPart.text).toBe('Hello world');
  });
});
