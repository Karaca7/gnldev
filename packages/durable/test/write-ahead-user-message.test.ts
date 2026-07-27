// WRITE-AHEAD user message (run.ts writeAheadIncoming): the thread ROW was always write-ahead
// (AgentMemory.loadContext → ensureThreadIndexed, titled from the first user text, pre-model) but the
// MESSAGES only landed at completion — so a run that died before its first token (provider 403, model
// returning nothing) left a titled-but-EMPTY thread and the user's own message vanished from every
// read surface. Reproduced live: a titled thread with 0 messages after a provider 403, the journal
// `:input` still present. These tests pin the new contract: the QUESTION survives any failure; retries (same runId
// AND the playground's fresh-runId-per-attempt) never duplicate it.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { runDurable, streamDurable } from '../src/run.js';
import { createMockModel, createMockStreamModel } from './mock.js';

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };

function replyModel() {
  return createMockModel(async () => ({
    content: [{ type: 'text', text: 'reply' }], finishReason: 'stop', usage, warnings: [],
  }));
}

/** A model whose provider rejects the call — the pre-first-token failure class (e.g. HTTP 403). */
function forbiddenModel() {
  return createMockModel(async () => { throw new Error('403 Forbidden'); });
}

const streamParts = [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '1' },
  { type: 'text-delta', id: '1', delta: 'reply' },
  { type: 'text-end', id: '1' },
  { type: 'finish', finishReason: 'stop', usage },
];

describe('write-ahead user message', () => {
  it('provider fails before the first token → the user message is ALREADY in the thread', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await expect(
      runDurable({ runId: 'wa1', journal, memory, threadId: 'twa1', model: forbiddenModel(), prompt: 'selam' }),
    ).rejects.toThrow('403');

    // The exact live-repro assertion: the thread is NOT empty — the question survived the failure.
    expect(await memory.getMessages('twa1')).toEqual([{ role: 'user', content: 'selam' }]);
    expect(await journal.get(runKeys.memUserAppended('wa1'))).toBe(true);
    // The produced half never happened.
    expect(await journal.get(runKeys.memAppended('wa1'))).toBeUndefined();
  });

  it('retry with the SAME runId after a failure → question stored exactly once, then the answer', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await expect(
      runDurable({ runId: 'wa2', journal, memory, threadId: 'twa2', model: forbiddenModel(), prompt: 'selam' }),
    ).rejects.toThrow('403');

    const r2 = await runDurable({ runId: 'wa2', journal, memory, threadId: 'twa2', model: replyModel(), prompt: 'selam' });
    expect(r2.text).toBe('reply');
    const saved = await memory.getMessages('twa2');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1); // tail-dedupe: no doubled question
    expect(saved.length).toBe(2);
  });

  it("retry with a NEW runId re-sending the identical text (playground's pattern) → no duplicate", async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await expect(
      runDurable({ runId: 'wa3-a', journal, memory, threadId: 'twa3', model: forbiddenModel(), prompt: 'selam' }),
    ).rejects.toThrow('403');

    // The playground mints a fresh `pg-${Date.now()}` per attempt — same text, different runId.
    const r2 = await runDurable({ runId: 'wa3-b', journal, memory, threadId: 'twa3', model: replyModel(), prompt: 'selam' });
    expect(r2.text).toBe('reply');
    const saved = await memory.getMessages('twa3');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1);
    expect(saved.length).toBe(2);
  });

  it('identical consecutive texts in SEPARATE completed turns are both kept (dedupe only bites unanswered tails)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await runDurable({ runId: 'wa4-a', journal, memory, threadId: 'twa4', model: replyModel(), prompt: 'devam' });
    // The previous turn COMPLETED → the thread tail is the assistant reply, not the user text →
    // historyEndsWithIncoming is false and this second, genuinely new "devam" is stored.
    await runDurable({ runId: 'wa4-b', journal, memory, threadId: 'twa4', model: replyModel(), prompt: 'devam' });

    const saved = await memory.getMessages('twa4');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2);
    expect(saved.length).toBe(4);
  });

  it('F1: full-history POSTing client (chat-route pattern) — echoed turns are stripped, memory stays linear', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const prompts: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => {
      prompts.push(prompt);
      return { content: [{ type: 'text', text: 'reply' }], finishReason: 'stop', usage, warnings: [] };
    });

    // Turn 1: plain prompt.
    await runDurable({ runId: 'f1-a', journal, memory, threadId: 'tf1', model, prompt: 'u1' });
    // Turn 2: the client echoes its WHOLE history — and its echo of the assistant turn is a
    // DIFFERENT shape than what memory stored (UIMessage→ModelMessage drift), so equality-based
    // dedupe can never catch it. Only the role rule (dropEchoedHistory) can.
    await runDurable({
      runId: 'f1-b', journal, memory, threadId: 'tf1', model,
      messages: [
        { role: 'user', content: 'u1' },
        { role: 'assistant', content: [{ type: 'text', text: 'reply (client echo, different shape)' }] },
        { role: 'user', content: 'u2' },
      ],
    });

    const saved = await memory.getMessages('tf1');
    // Linear transcript: u1, a1, u2, a2 — no compounded re-persist of the echoed turns.
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2);
    expect(saved.length).toBe(4);
    // The turn-2 prompt contains u1 exactly ONCE (server history), not doubled by the client echo.
    const turn2Users = (prompts[1] ?? []).filter((m: any) => m?.role === 'user');
    expect(turn2Users.length).toBe(2); // u1 (from memory) + u2 (new)
  });

  it('F1 boundary: seeding a NEW thread with a transcript (assistant included) still persists wholesale', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await runDurable({
      runId: 'f1-seed', journal, memory, threadId: 'tf1s', model: replyModel(),
      messages: [
        { role: 'user', content: 'few-shot q' },
        { role: 'assistant', content: [{ type: 'text', text: 'few-shot a' }] },
        { role: 'user', content: 'real question' },
      ],
    });

    const saved = await memory.getMessages('tf1s');
    // Empty history → dropEchoedHistory is a no-op: the whole seed + the produced reply persist.
    expect(saved.length).toBe(4);
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2);
  });

  it('F4: resume after INTERLEAVED turns — the resumed prompt carries the question once, memory stays clean', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const prompts: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => {
      prompts.push(prompt);
      return { content: [{ type: 'text', text: 'reply' }], finishReason: 'stop', usage, warnings: [] };
    });

    // Attempt 1 of run A fails AFTER its write-ahead landed (the question is in the thread).
    await expect(
      runDurable({ runId: 'f4-a', journal, memory, threadId: 'tf4', model: forbiddenModel(), prompt: 'pay' }),
    ).rejects.toThrow('403');
    // An UNRELATED turn lands on the same thread meanwhile → 'pay' is no longer the thread tail.
    await runDurable({ runId: 'f4-x', journal, memory, threadId: 'tf4', model, prompt: 'other' });

    // Re-entry of run A (same runId): tail-dedupe can't match, but the memUserAppended marker is
    // done and the stored copy is visible in the loaded history → the re-concat is dropped.
    await runDurable({ runId: 'f4-a', journal, memory, threadId: 'tf4', model, prompt: 'pay' });

    const resumedPrompt = prompts[prompts.length - 1] ?? [];
    const pays = resumedPrompt.filter((m: any) => m?.role === 'user' && JSON.stringify(m).includes('pay'));
    expect(pays.length).toBe(1); // prompt fidelity: the question appears exactly once
    const saved = await memory.getMessages('tf4');
    expect(saved.filter((m: any) => m?.role === 'user' && JSON.stringify(m).includes('pay')).length).toBe(1);
  });

  // F5 meta-audit note: this branch was first shipped with the claim "untestable without clock
  // injection" — that claim was WRONG: vitest's fake timers mock Date.now(), and the mock model can
  // advance the clock mid-run, so the "fresh at write-ahead, stale by completion" window is fully
  // reproducible. Kept as the honest correction of that overclaim.
  it('F5: a foreign pending claim that goes STALE mid-run is taken over at completion — question rides with the answer', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const journal = new InMemoryJournal();
      const memory = new BasicMemory(journal);
      // A foreign worker's FRESH pending claim on the user-half marker (as if its append is in flight).
      await journal.put(runKeys.memUserAppended('f5'), { status: 'pending', startedAt: Date.now() });
      const model = createMockModel(async () => {
        // The model call takes "61 seconds" — by completion time the foreign claim is stale.
        vi.setSystemTime(Date.now() + 61_000);
        return { content: [{ type: 'text', text: 'reply' }], finishReason: 'stop', usage, warnings: [] };
      });

      await runDurable({ runId: 'f5', journal, memory, threadId: 'tf5', model, prompt: 'selam' });

      const saved = await memory.getMessages('tf5');
      // Write-ahead SKIPPED (fresh foreign claim) — but the completion append took over the stale
      // claim and recovered the question alongside the answer.
      expect(saved).toEqual([{ role: 'user', content: 'selam' }, expect.objectContaining({ role: 'assistant' })]);
      expect(await journal.get(runKeys.memUserAppended('f5'))).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('streamDurable parity: pre-stream provider failure keeps the question; the stream call itself rejects', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const badStream = createMockStreamModel(streamParts);
    (badStream as any).doStream = async () => { throw new Error('403 Forbidden'); };

    const r = await streamDurable({ runId: 'wa5', journal, memory, threadId: 'twa5', model: badStream, prompt: 'selam' });
    // The AI SDK wraps a pre-token provider error in its own "No output generated" surface — the
    // exact message is the SDK's contract, not ours; what this test pins is the rejection + survival.
    await expect(r.text).rejects.toThrow();

    expect(await memory.getMessages('twa5')).toEqual([{ role: 'user', content: 'selam' }]);

    // Retry with a fresh runId (playground behavior) on a WORKING model → clean single turn.
    const r2 = await streamDurable({
      runId: 'wa5-b', journal, memory, threadId: 'twa5', model: createMockStreamModel(streamParts), prompt: 'selam',
    });
    await r2.text;
    const t0 = Date.now();
    while ((await memory.getMessages('twa5')).length < 2 && Date.now() - t0 < 1000) {
      await new Promise((res) => setTimeout(res, 10));
    }
    const saved = await memory.getMessages('twa5');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1);
    expect(JSON.stringify(saved)).toContain('reply');
  });
});
