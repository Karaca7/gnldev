// Two things the streaming crash-window fix (stream-crash-window.test.ts) still did in silence.
//
// 1. The write-ahead copy of a model step — `{ parts, rest, partial: true }`, written the moment a
//    tool call arrives and cut off right there — is replayed by the resume as if it were the turn the
//    model actually finished. That replay is CORRECT (it is what stops the resume from re-planning and
//    charging twice), but the turn it hands back has no closing text, no finish reason and no usage.
//    Nothing said so, so an operator looking at a truncated assistant turn had nothing to go on.
//
// 2. That same write-ahead put was wrapped in `catch { /* best-effort */ }`. A journal that rejects it
//    reopens the exact duplicate-side-effect window the checkpoint exists to close — silently.
//
// Both stay non-fatal. Both are now VOCAL.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { stepCountIs, tool } from 'ai';
import { z } from 'zod';
import { streamDurable, InMemoryJournal, runKeys } from '../src/index.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function parts(list: any[]) {
  return new ReadableStream({
    start(c) { for (const p of list) c.enqueue(p); c.close(); },
  });
}

/** Same shape as stream-crash-window's model: a fresh toolCallId per completion, and `hang: true`
 *  emits the tool call and never closes — a process killed mid-stream, so flush() never runs. */
function streamingModel(callId: string, hang = false) {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'streamer', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream-only'); },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        const head = [
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' },
          { type: 'text-delta', id: '1', delta: 'charging' },
          { type: 'tool-call', toolCallId: callId, toolName: 'chargeCard', input: JSON.stringify({ amount: 2000 }) },
        ];
        if (hang) {
          return { stream: new ReadableStream({ start(c) { for (const p of head) c.enqueue(p); /* never close */ } }) };
        }
        return {
          stream: parts([...head, { type: 'text-end', id: '1' }, { type: 'finish', finishReason: 'tool-calls', usage }]),
        };
      }
      return {
        stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '2' }, { type: 'text-delta', id: '2', delta: 'done' }, { type: 'text-end', id: '2' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
      };
    },
  } as any;
}

/** A model that emits TWO tool calls in one step — so the write-ahead put fires more than once per
 *  stream and "one warning per stream, not per chunk" is actually measurable. */
function twoToolCallModel() {
  return {
    specificationVersion: 'v2', provider: 'scripted', modelId: 'streamer-2', supportedUrls: {},
    doGenerate: async () => { throw new Error('stream-only'); },
    doStream: async ({ prompt }: any) => {
      const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
      if (done === 0) {
        return {
          stream: parts([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: 'c-1', toolName: 'chargeCard', input: JSON.stringify({ amount: 10 }) },
            { type: 'tool-call', toolCallId: 'c-2', toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]),
        };
      }
      return {
        stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: '1' }, { type: 'text-delta', id: '1', delta: 'settled' }, { type: 'text-end', id: '1' },
          { type: 'finish', finishReason: 'stop', usage },
        ]),
      };
    },
  } as any;
}

function chargeTool() {
  let charges = 0;
  const t = tool({
    description: 'charge',
    inputSchema: z.object({ amount: z.number() }),
    execute: async () => { charges++; return { chargeId: `ch_${charges}` }; },
  });
  Object.assign(t, { sideEffect: true });
  return { chargeCard: t as any, charges: () => charges };
}

async function drain(res: any) {
  try { for await (const _ of res.fullStream) { /* consume */ } } catch { /* the crash */ }
}

/** Kills the stream at the moment the tool result lands — flush() never runs, so `model:0` is left
 *  as the write-ahead (partial) copy. */
async function crashAfterTool(runId: string, journal: InMemoryJournal, tools: any) {
  const res = await streamDurable({ runId, journal, model: streamingModel('call-A', true), tools, prompt: 'charge' } as any);
  const reader = (res as any).fullStream.getReader();
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (value?.type === 'tool-result') break;
  }
  await reader.cancel().catch(() => {});
}

afterEach(() => { vi.restoreAllMocks(); });

describe('replaying a partial (write-ahead) model step', () => {
  it('says so — exactly once, naming the run, the step and what the record lacks', async () => {
    const journal = new InMemoryJournal();
    const { chargeCard, charges } = chargeTool();
    const runId = 'pr-1';

    await crashAfterTool(runId, journal, { chargeCard });
    const step0 = await journal.get<any>(runKeys.model(runId, 0));
    expect(step0?.partial, 'the crash must leave a write-ahead (partial) record').toBe(true);

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await streamDurable({
      runId, journal, model: streamingModel('call-B'), tools: { chargeCard }, prompt: 'charge',
      stopWhen: stepCountIs(4),
    } as any);
    await drain(second);

    const lines = warn.mock.calls.map((c) => String(c[0]));
    const partialLines = lines.filter((l) => l.includes('partial'));
    expect(partialLines, `expected exactly one partial-replay warning, got:\n${lines.join('\n')}`).toHaveLength(1);
    expect(partialLines[0]).toContain(runId);
    expect(partialLines[0]).toContain('step 0');
    expect(partialLines[0]).toContain('partial: true');
    // The point of naming what is missing: this record was cut off before the stream's tail.
    expect(partialLines[0]).toContain('finish');
    expect(charges(), 'the replay must not re-run the side effect').toBe(1);
  });

  it('stays silent when the replayed step is COMPLETE', async () => {
    const journal = new InMemoryJournal();
    const { chargeCard } = chargeTool();
    const runId = 'pr-2';

    const first = await streamDurable({
      runId, journal, model: streamingModel('call-A'), tools: { chargeCard }, prompt: 'charge',
      stopWhen: stepCountIs(4),
    } as any);
    await drain(first);
    expect((await journal.get<any>(runKeys.model(runId, 0)))?.partial, 'a flushed step carries no partial flag').toBeUndefined();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const second = await streamDurable({
      runId, journal, model: streamingModel('call-B'), tools: { chargeCard }, prompt: 'charge',
      stopWhen: stepCountIs(4),
    } as any);
    await drain(second);

    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines.filter((l) => l.includes('partial')), `unexpected warning:\n${lines.join('\n')}`).toHaveLength(0);
  });
});

describe('a write-ahead checkpoint the journal refuses', () => {
  /** Rejects exactly the mid-stream write-ahead put (the model key carrying `partial: true`); the
   *  final flush write and everything else go through, as a transient journal fault would. */
  class RejectsWriteAhead extends InMemoryJournal {
    rejected = 0;
    override async put(key: string, value: unknown): Promise<void> {
      if (key.includes(':model:') && (value as { partial?: boolean })?.partial === true) {
        this.rejected++;
        throw new Error('journal write rejected (simulated outage)');
      }
      return super.put(key, value);
    }
  }

  it('warns once per stream, does not break the stream, and the tool still runs', async () => {
    const journal = new RejectsWriteAhead();
    const { chargeCard, charges } = chargeTool();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await streamDurable({
      runId: 'pr-3', journal, model: twoToolCallModel(), tools: { chargeCard }, prompt: 'charge',
      stopWhen: stepCountIs(4),
    } as any);
    let text = '';
    for await (const part of (res as any).fullStream) {
      if (part?.type === 'text-delta') text += part.text ?? part.delta ?? '';
    }

    expect(journal.rejected, 'both tool-call chunks must have attempted the write-ahead').toBe(2);
    expect(charges(), 'the tools still ran — the failed checkpoint is non-fatal').toBe(2);
    expect(text, 'the stream still completed').toContain('settled');
    expect(await journal.get(runKeys.model('pr-3', 0)), 'flush still journaled the complete step').toBeDefined();

    const lines = warn.mock.calls.map((c) => String(c[0]));
    const failureLines = lines.filter((l) => l.includes('write-ahead checkpoint FAILED'));
    expect(failureLines, `expected one write-ahead failure warning, got:\n${lines.join('\n')}`).toHaveLength(1);
    expect(failureLines[0]).toContain('pr-3');
    expect(failureLines[0]).toContain('step 0');
  });
});
