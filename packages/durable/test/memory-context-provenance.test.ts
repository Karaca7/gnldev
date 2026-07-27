// Memory-context provenance (':memctx', runKeys.memoryContext): the frozen ':input' says WHAT the
// model saw; this record says WHERE each part came from. Assembled by prepareMemoryContext
// (recall/recent/WM/OM breakdown from the memory implementation + the run-side incoming/echo-trim
// counts) and frozen ONCE next to ':input' (first attempt wins). These tests pin the record's shape
// on the paths a studio user actually hits: legacy BasicMemory, a rich loadContext memory, the
// echo-trimming client, and the once-only freeze semantics.
import { describe, it, expect } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import type { Memory } from '../src/memory.js';
import type { MemoryContextRecord } from '../src/run.js';
import { runDurable, streamDurable } from '../src/run.js';
import { replayRun } from '../src/regression.js';
import { createMockModel, createMockStreamModel } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const replyModel = () =>
  createMockModel(async () => ({ content: [{ type: 'text', text: 'reply' }], finishReason: 'stop', usage, warnings: [] }));

describe('memory-context provenance (:memctx)', () => {
  it('legacy BasicMemory: recentCount/incomingCount recorded; no recall refs', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    await runDurable({ runId: 'mc1-a', journal, memory, threadId: 'tmc1', model: replyModel(), prompt: 'u1' });
    await runDurable({ runId: 'mc1-b', journal, memory, threadId: 'tmc1', model: replyModel(), prompt: 'u2' });

    const rec = await journal.get<MemoryContextRecord>(runKeys.memoryContext('mc1-b'));
    expect(rec).toMatchObject({ v: 1, threadId: 'tmc1', recalled: [], recentCount: 2, incomingCount: 1, echoTrimmed: 0 });
    // The window ITSELF rides along as refs — role + preview per injected message (legacy path).
    expect(rec?.recent?.map((r) => [r.role, r.preview])).toEqual([
      ['user', 'u1'],
      ['assistant', 'reply'],
    ]);
    // Structural preview: a tool-call/tool-result message no longer refs as an empty string.
    const { messagePreview } = await import('../src/memory.js');
    expect(messagePreview({ role: 'assistant', content: [{ type: 'tool-call', toolName: 'searchResource', input: '{"q":"x"}' }] }))
      .toBe('→ searchResource({"q":"x"})');
    expect(messagePreview({ role: 'tool', content: [{ type: 'tool-result', toolName: 'searchResource', output: { hits: 1 } }] }))
      .toBe('searchResource → {"hits":1}');
  });

  it('rich loadContext memory: recall refs (with similarity) and WM chars flow into the record', async () => {
    const journal = new InMemoryJournal();
    const rich: Memory = {
      async getMessages() { return []; },
      async append() {},
      async loadContext() {
        return {
          messages: [{ role: 'user', content: 'old related q' }],
          system: '# Working Memory\nuser likes tea',
          provenance: {
            recalled: [{ threadId: 'tmc2', seq: 4, role: 'user', preview: 'old related q', score: 0.87 }],
            recentCount: 1,
            workingMemoryChars: 31,
          },
        };
      },
    };
    await runDurable({ runId: 'mc2', journal, memory: rich, threadId: 'tmc2', model: replyModel(), prompt: 'new q' });

    const rec = await journal.get<MemoryContextRecord>(runKeys.memoryContext('mc2'));
    expect(rec?.recalled).toEqual([{ threadId: 'tmc2', seq: 4, role: 'user', preview: 'old related q', score: 0.87 }]);
    expect(rec?.workingMemoryChars).toBe(31);
    expect(rec?.recentCount).toBe(1);
    expect(rec?.incomingCount).toBe(1);
  });

  it('echo-trimming client (F1): echoTrimmed counts the stripped echoes', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    await runDurable({ runId: 'mc3-a', journal, memory, threadId: 'tmc3', model: replyModel(), prompt: 'first' });
    await runDurable({
      runId: 'mc3-b', journal, memory, threadId: 'tmc3', model: replyModel(),
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'text', text: 'echo of the answer' }] },
        { role: 'user', content: 'second' },
      ],
    });

    const rec = await journal.get<MemoryContextRecord>(runKeys.memoryContext('mc3-b'));
    expect(rec?.echoTrimmed).toBe(2); // the echoed user+assistant pair
    expect(rec?.incomingCount).toBe(1); // only the genuinely new message
  });

  it('freeze semantics: a same-runId retry does NOT overwrite the first attempt\'s record', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    await runDurable({ runId: 'mc4', journal, memory, threadId: 'tmc4', model: replyModel(), prompt: 'q' });
    const first = await journal.get<MemoryContextRecord>(runKeys.memoryContext('mc4'));
    expect(first?.recentCount).toBe(0); // fresh thread on attempt 1

    // Same runId re-entry: the thread now has attempt 1's turn, but the frozen record must not move.
    await runDurable({ runId: 'mc4', journal, memory, threadId: 'tmc4', model: replyModel(), prompt: 'q' });
    const second = await journal.get<MemoryContextRecord>(runKeys.memoryContext('mc4'));
    expect(second).toEqual(first);
  });

  it('counterfactual memory-off replay: strips exactly the provably-injected history, keeps the turn', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // Two turns → turn 2's frozen input = [q1, a1, q2] with memctx.incomingCount = 1.
    await runDurable({ runId: 'cf-a', journal, memory, threadId: 'tcf', model: replyModel(), prompt: 'ilk soru' });
    await runDurable({ runId: 'cf-b', journal, memory, threadId: 'tcf', model: replyModel(), prompt: 'ikinci soru' });

    const prompts: any[] = [];
    const probe = createMockModel(async ({ prompt }: any) => {
      prompts.push(prompt);
      return { content: [{ type: 'text', text: 'cf' }], finishReason: 'stop', usage, warnings: [] };
    });
    await replayRun({ journal: journal as any, runId: 'cf-b', model: probe, stripMemoryContext: true });

    // The replayed model saw ONLY the turn's own message — the memory-composed history is gone.
    const users = (prompts[0] ?? []).filter((m: any) => m?.role === 'user');
    expect(users.length).toBe(1);
    expect(JSON.stringify(users[0])).toContain('ikinci soru');
    expect(JSON.stringify(prompts[0])).not.toContain('ilk soru');

    // No provenance record → the strip refuses instead of guessing (memory-less run).
    await runDurable({ runId: 'cf-plain', journal, model: replyModel(), prompt: 'x' });
    await expect(
      replayRun({ journal: journal as any, runId: 'cf-plain', model: probe, stripMemoryContext: true }),
    ).rejects.toThrow('memctx');
  });

  it('streamDurable parity: the record is frozen pre-stream too; no memory/threadId → no record', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const parts = [
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'reply' },
      { type: 'text-end', id: '1' },
      { type: 'finish', finishReason: 'stop', usage },
    ];
    const r = await streamDurable({ runId: 'mc5', journal, memory, threadId: 'tmc5', model: createMockStreamModel(parts), prompt: 'q' });
    await r.text;
    expect(await journal.get(runKeys.memoryContext('mc5'))).toMatchObject({ v: 1, threadId: 'tmc5' });

    // A memory-less run journals nothing under :memctx.
    await runDurable({ runId: 'mc6', journal, model: replyModel(), prompt: 'q' });
    expect(await journal.get(runKeys.memoryContext('mc6'))).toBeUndefined();
  });
});
