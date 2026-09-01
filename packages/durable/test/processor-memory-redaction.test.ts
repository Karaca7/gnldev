// Processors mask what the model sees and what the caller gets back — thread MEMORY was the hole.
//
// Two separate leaks were measured before this suite existed, both only reachable with
// `memory && threadId` (a journal-only setup was never affected):
//
//   A — the user's own message. `incoming` is captured BEFORE applyInputProcessors, the processors
//       are PURE (new array + new objects, the caller's array untouched), so the pre-processor
//       reference still pointed at the raw text when writeAheadIncoming persisted it:
//         JOURNAL raw PII: false · MEMORY raw PII: true
//
//   B — the assistant's reply. The output-processor pass shadows `result.text`/`result.response`,
//       but the memory append re-read the messages off `result.steps[]`, which is NOT shadowed, so
//       the masked copy never reached the append:
//         caller-visible text masked: true · MEMORY assistant message raw: true
//
// The processor used here is written exactly like @gnldev/processors' piiRedactor (pure, new
// objects, both hooks) — the bug is in the ENGINE, so the durable package pins it without taking a
// dependency on the processor package.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { runDurable, streamDurable } from '../src/run.js';
import { replayRun } from '../src/regression.js';
import type { Processor } from '../src/processor.js';
import { createMockModel, createMockStreamModel, finalTextResult } from './mock.js';

const SECRET = 'gizli@ornek.com';
const MASK = '[MASKED_EMAIL]';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;

const redactText = (s: string) => s.replace(EMAIL, MASK);
function redactMessage(m: any): any {
  if (typeof m?.content === 'string') return { ...m, content: redactText(m.content) };
  if (Array.isArray(m?.content)) {
    return { ...m, content: m.content.map((p: any) => (typeof p?.text === 'string' ? { ...p, text: redactText(p.text) } : p)) };
  }
  return m;
}

/** Pure, deterministic, both directions — the piiRedactor shape. */
const redactor: Processor = {
  name: 'redactor',
  processInput: (i) => ({
    system: typeof i.system === 'string' ? redactText(i.system) : i.system,
    prompt: typeof i.prompt === 'string' ? redactText(i.prompt) : i.prompt,
    messages: i.messages ? i.messages.map(redactMessage) : i.messages,
  }),
  processOutput: (o) => ({
    ...o,
    text: typeof o.text === 'string' ? redactText(o.text) : o.text,
    messages: o.messages ? o.messages.map(redactMessage) : o.messages,
  }),
};

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const replyModel = (text = 'tamam') => createMockModel(async () => finalTextResult(text));
const forbiddenModel = () => createMockModel(async () => { throw new Error('403 Forbidden'); });

const streamParts = (text: string) => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '1' },
  { type: 'text-delta', id: '1', delta: text },
  { type: 'text-end', id: '1' },
  { type: 'finish', finishReason: 'stop', usage },
];

/** Everything memory holds for a thread, as one string — the surface an operator/exporter reads. */
async function threadDump(memory: BasicMemory, threadId: string): Promise<string> {
  return JSON.stringify(await memory.getMessages(threadId));
}

describe('processors + memory: nothing raw reaches the thread', () => {
  it('LEAK A — the incoming user message lands in memory MASKED, not raw', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('tamam'); });

    await runDurable({
      runId: 'a1', journal, memory, threadId: 'ta1', model, processors: [redactor],
      prompt: `mail: ${SECRET}`,
    });

    const dump = await threadDump(memory, 'ta1');
    expect(dump).not.toContain(SECRET); // the measured failure: memory used to hold the raw address
    expect(dump).toContain(MASK);
    // The model never saw it either (that part already worked) — pinned so a fix can't "solve" the
    // leak by moving the raw text somewhere else.
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    // …and the journal's frozen input stays masked, as before.
    expect(JSON.stringify(await journal.get(runKeys.input('a1')))).not.toContain(SECRET);
  });

  it('LEAK A (write-ahead half) — a run that dies before its first token stores the MASKED question', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await expect(
      runDurable({
        runId: 'a2', journal, memory, threadId: 'ta2', model: forbiddenModel(), processors: [redactor],
        prompt: `mail: ${SECRET}`,
      }),
    ).rejects.toThrow('403');

    // write-ahead still fires (the question survives the failure) — but masked.
    const saved = await memory.getMessages('ta2');
    expect(saved.length).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(saved)).toContain(MASK);
  });

  it('LEAK B — the assistant reply lands in memory MASKED (result.steps is not the source of truth)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    const r = await runDurable({
      runId: 'b1', journal, memory, threadId: 'tb1', model: replyModel(`cevap: ${SECRET}`),
      processors: [redactor], prompt: 'soru',
    });

    expect(r.text).toBe(`cevap: ${MASK}`); // caller side always worked
    const dump = await threadDump(memory, 'tb1');
    expect(dump).not.toContain(SECRET); // the measured failure: memory held the raw reply
    expect(dump).toContain(MASK);
  });

  it('LEAK B (stream parity) — a streamed reply is masked in memory too', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    const r = await streamDurable({
      runId: 'b2', journal, memory, threadId: 'tb2', model: createMockStreamModel(streamParts(`cevap: ${SECRET}`)),
      processors: [redactor], prompt: `mail: ${SECRET}`,
    });
    await r.text;
    const t0 = Date.now();
    while ((await memory.getMessages('tb2')).length < 2 && Date.now() - t0 < 1000) {
      await new Promise((res) => setTimeout(res, 10));
    }
    // The wait must have SUCCEEDED, asserted separately: without this the test is a proven sham —
    // measured, deleting the stream path's memory append entirely (or delaying it past the timeout)
    // leaves a thread holding only the masked question, and `not.toContain(SECRET)` passes on it.
    expect((await memory.getMessages('tb2')).length).toBe(2);

    const dump = await threadDump(memory, 'tb2');
    expect(dump).not.toContain(SECRET); // both halves: the question (leak A) and the reply (leak B)
    expect(dump).toContain(MASK);
  });

  it('no memory attached → byte-for-byte unchanged (the leak was never reachable there)', async () => {
    const journal = new InMemoryJournal();
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult(`cevap: ${SECRET}`); });

    const r = await runDurable({
      runId: 'c1', journal, model, processors: [redactor], prompt: `mail: ${SECRET}`,
    });

    expect(r.text).toBe(`cevap: ${MASK}`);
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(await journal.get(runKeys.input('c1')))).not.toContain(SECRET);
    // No threadId either → the memory branch is skipped entirely.
    const r2 = await runDurable({
      runId: 'c2', journal, memory: new BasicMemory(journal), model: replyModel('ok'), processors: [redactor],
      prompt: `mail: ${SECRET}`,
    });
    expect(r2.text).toBe('ok');
  });

  it('retry with the SAME runId → the question stays in memory exactly once, still masked', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await expect(
      runDurable({
        runId: 'd1', journal, memory, threadId: 'td1', model: forbiddenModel(), processors: [redactor],
        prompt: `mail: ${SECRET}`,
      }),
    ).rejects.toThrow('403');

    await runDurable({
      runId: 'd1', journal, memory, threadId: 'td1', model: replyModel('tamam'), processors: [redactor],
      prompt: `mail: ${SECRET}`,
    });

    const saved = await memory.getMessages('td1');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1); // the memUserAppended marker holds
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });

  it("retry with a NEW runId re-sending the same text (playground pattern) → no duplicate question", async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);

    await expect(
      runDurable({
        runId: 'd2-a', journal, memory, threadId: 'td2', model: forbiddenModel(), processors: [redactor],
        prompt: `mail: ${SECRET}`,
      }),
    ).rejects.toThrow('403');

    // The tail-dedupe compares the loaded history against this turn's incoming. Once memory holds the
    // MASKED copy, that comparison only matches if it happens on the masked shapes as well — the
    // reason the reconcile runs AFTER the processors rather than before.
    await runDurable({
      runId: 'd2-b', journal, memory, threadId: 'td2', model: replyModel('tamam'), processors: [redactor],
      prompt: `mail: ${SECRET}`,
    });

    const saved = await memory.getMessages('td2');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1);
    expect(saved.length).toBe(2);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });

  it('a second turn on the same thread: history stays masked and is not re-persisted', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'te1', processors: [redactor] } as const;

    await runDurable({ ...opts, runId: 'e1-a', model: replyModel('bir'), prompt: `mail: ${SECRET}` });
    await runDurable({ ...opts, runId: 'e1-b', model: replyModel('iki'), prompt: `tel: ${SECRET}` });

    const saved = await memory.getMessages('te1');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2); // both turns, no compounding
    expect(saved.length).toBe(4);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });

  it('a processor that DROPS messages (trim-oldest shape) → the new turn is still persisted once, masked', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // tokenLimiter's trim-oldest: a FILTER over the incoming array — survivors keep their identity,
    // and it protects the last user message. Combined with the redactor so both a count change and a
    // rebuild happen in the same chain.
    const trimOldest: Processor = {
      name: 'trim-oldest',
      processInput: (i) => (i.messages && i.messages.length > 2 ? { ...i, messages: i.messages.filter((_, idx) => idx > 0) } : i),
    };
    const opts = { journal, memory, threadId: 'tf1', processors: [redactor, trimOldest] } as const;

    await runDurable({ ...opts, runId: 'f1-a', model: replyModel('bir'), prompt: 'ilk soru' });
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('iki'); });
    await runDurable({ ...opts, runId: 'f1-b', model, prompt: `mail: ${SECRET}` });

    // The trim really happened (3 messages in, 2 out) — otherwise this test proves nothing.
    expect(seen[0].length).toBe(2);
    const saved = await memory.getMessages('tf1');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2); // the new turn, exactly once
    expect(saved.length).toBe(4);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// The three ways a chain can leave NO post-processor copy of the turn. Each one used to be silent,
// and two of them used to fall back to the PRE-processor array — which is the leak itself, since
// those messages are the caller's raw ones. Every assertion below is on BEHAVIOR (what a thread
// read returns), never on which internal branch ran.
// ---------------------------------------------------------------------------------------------
describe('processors that leave no copy of the turn: nothing raw, nothing silent', () => {
  /** Legal ProcessorInput, no `messages` array on the way out: this turn is flattened into `prompt`. */
  const flatten: Processor = {
    name: 'flatten',
    processInput: (i) => {
      const all = [
        ...(i.messages ?? []).map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))),
        ...(typeof i.prompt === 'string' ? [i.prompt] : []),
      ].join('\n');
      return { system: typeof i.system === 'string' ? redactText(i.system) : i.system, prompt: redactText(all), messages: undefined };
    },
  };

  /** tokenLimiter's worst case: the trim could not protect the newest turn and dropped it. */
  const dropNewest: Processor = {
    name: 'drop-newest',
    processInput: (i) => (i.messages && i.messages.length > 1 ? { ...i, messages: i.messages.slice(0, -1) } : i),
  };

  /** The summarizer shape: history is rewritten into one new object, the new question rides through. */
  const summarize: Processor = {
    name: 'summarize',
    processInput: (i) => {
      if (!i.messages || i.messages.length < 3) return i;
      const last = i.messages[i.messages.length - 1];
      return { ...i, messages: [{ role: 'user', content: `ozet(${i.messages.length - 1})` }, { role: last.role, content: last.content }] };
    },
  };

  /** Everything collapses into one brand-new message: no identity and no shape survives the chain. */
  const collapse: Processor = {
    name: 'collapse',
    processInput: (i) => (i.messages ? { ...i, messages: [{ role: 'user' as const, content: `birlesik(${i.messages.length})` }] } : i),
  };

  it('a chain that flattens messages into `prompt` → memory holds NO raw copy of the question', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    await runDurable({
      runId: 'g1', journal, memory, threadId: 'tg1', model: replyModel('tamam'), processors: [flatten],
      prompt: `mail: ${SECRET}`,
    });

    // The measured leak: `messages` is gone, so the pre-chain array was persisted verbatim — raw.
    expect(await threadDump(memory, 'tg1')).not.toContain(SECRET);
    // Not persisting the question is the only safe answer here, so it must not be silent.
    expect(warn.mock.calls.flat().join(' ')).toContain('no recoverable copy of this turn');
    const rec: any = await journal.get(runKeys.memoryContext('g1'));
    expect(rec.incomingUnrecoverable).toBe('messages-dropped');
    expect(rec.incomingCount).toBe(0); // regression.ts slices this many trailing messages — 0 = "refuse"
    warn.mockRestore();
  });

  it('stream parity — the same chain leaks nothing through streamDurable either', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const r = await streamDurable({
      runId: 'g2', journal, memory, threadId: 'tg2', model: createMockStreamModel(streamParts('tamam')),
      processors: [flatten], prompt: `mail: ${SECRET}`,
    });
    await r.text;
    const t0 = Date.now();
    while ((await memory.getMessages('tg2')).length < 1 && Date.now() - t0 < 1000) {
      await new Promise((res) => setTimeout(res, 10));
    }
    expect((await memory.getMessages('tg2')).length).toBe(1); // the answer landed — the wait really ran
    expect(await threadDump(memory, 'tg2')).not.toContain(SECRET);
    expect(warn.mock.calls.flat().join(' ')).toContain('no recoverable copy of this turn');
    warn.mockRestore();
  });

  it('a chain that DROPS the newest turn → the dropped question is not smuggled into memory raw', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'tg3', processors: [redactor, dropNewest] } as const;

    await runDurable({ ...opts, runId: 'g3-a', model: replyModel('bir'), prompt: 'ilk soru' });
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('iki'); });
    await runDurable({ ...opts, runId: 'g3-b', model, prompt: `mail: ${SECRET}` });

    // The drop really happened: the model never saw turn 2 at all.
    expect(JSON.stringify(seen)).not.toContain('mail:');
    // …so memory must not hold it either, and above all not in its RAW form.
    const dump = await threadDump(memory, 'tg3');
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('mail:');
    // Losing the user's question is exactly the outcome that has to be reported.
    expect(warn.mock.calls.flat().join(' ')).toContain('turn-dropped');
    warn.mockRestore();
  });

  it('a SUMMARIZER chain → the question survives into memory instead of vanishing', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'tg4', processors: [redactor, summarize] } as const;

    await runDurable({ ...opts, runId: 'g4-a', model: replyModel('bir'), prompt: 'ilk soru' });
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('iki'); });
    await runDurable({ ...opts, runId: 'g4-b', model, prompt: `ikinci soru mail: ${SECRET}` });

    // The summary really replaced the history (3 in, 2 out) and the model DID see turn 2 masked.
    expect(seen[0].length).toBe(2);
    expect(JSON.stringify(seen)).toContain(MASK);
    const saved = await memory.getMessages('tg4');
    // The measured regression: the old end-biased clamp collapsed the split onto the array end, so
    // turn 2 was persisted as an answer with no question — a conversation missing what was asked.
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2);
    expect(JSON.stringify(saved)).toContain(`ikinci soru mail: ${MASK}`);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
  });

  it('a chain where nothing at all survives → still no raw copy, and the loss is recorded', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'tg5', processors: [redactor, collapse] } as const;

    await runDurable({ ...opts, runId: 'g5-a', model: replyModel('bir'), prompt: 'ilk soru' });
    await runDurable({ ...opts, runId: 'g5-b', model: replyModel('iki'), prompt: `mail: ${SECRET}` });

    expect(await threadDump(memory, 'tg5')).not.toContain(SECRET);
    expect(warn.mock.calls.flat().join(' ')).toContain('boundary-lost');
    expect(((await journal.get(runKeys.memoryContext('g5-b'))) as any).incomingUnrecoverable).toBe('boundary-lost');
    warn.mockRestore();
  });

  it('the shape-only dedupe is recorded in `:memctx`, so a collapsed turn is auditable', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'tg6', processors: [redactor] } as const;

    // Attempt 1 dies after the write-ahead → the thread tail is the masked question, unanswered.
    await expect(runDurable({ ...opts, runId: 'g6-a', model: forbiddenModel(), prompt: `mail: ${SECRET}` })).rejects.toThrow('403');
    // A DIFFERENT raw address that redacts to the very same string: indistinguishable from a retry.
    await runDurable({ ...opts, runId: 'g6-b', model: replyModel('tamam'), prompt: 'mail: baska@ornek.com' });

    const saved = await memory.getMessages('tg6');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1); // collapsed, as a retry would be
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    // …but the run says so, instead of the turn disappearing without a trace.
    expect(((await journal.get(runKeys.memoryContext('g6-b'))) as any).incomingDedupedByShape).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Where the boundary is CARRIED, not guessed. Each test below fails on a DIFFERENT signal of
// trackIncomingBoundary, and each one asserts on what a thread read returns — never on an index.
//
// Measured before the ordering fix (the whole point of this block): the cheap positional shortcuts
// (equal count / boundary 0) ran BEFORE the identity and shape evidence and won, so a processor
// that moved the turn without changing the message count anchored the boundary on the wrong row —
// silently, with `:memctx` still claiming success.
// ---------------------------------------------------------------------------------------------
describe('the history/incoming boundary survives processors that MOVE the turn', () => {
  it('a NET-ZERO trim (drop one, append one) → memory holds the question, not the processor’s note', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // Perfectly legal Processor: redact → trim the oldest → leave a marker. The message COUNT is
    // unchanged, so the "count unchanged ⇒ positions held" shortcut is true about the length and
    // false about every index. Measured before the fix: the thread stored `[older turns trimmed]`
    // as turn 2, the user's question was nowhere, `:memctx.incomingCount` was 1 (claiming success)
    // and no `incomingUnrecoverable` stamp was written — a silent loss.
    const trimAndNote: Processor = {
      name: 'redact-trim-note',
      processInput: (i) => {
        const msgs = (i.messages ?? []).map(redactMessage);
        if (msgs.length >= 3) {
          msgs.shift();
          msgs.push({ role: 'system', content: '[older turns trimmed]' });
        }
        return { system: i.system, prompt: i.prompt, messages: msgs };
      },
    };
    const opts = { journal, memory, threadId: 'th1', processors: [trimAndNote] } as const;

    await runDurable({ ...opts, runId: 'h1-a', model: replyModel('bir'), prompt: 'ilk soru' });
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('iki'); });
    await runDurable({ ...opts, runId: 'h1-b', model, prompt: `mail: ${SECRET}` });

    // The net-zero trim really happened — 3 in, 3 out, with the oldest gone and a note appended.
    expect(seen[0].length).toBe(3);
    expect(JSON.stringify(seen[0])).not.toContain('ilk soru');
    expect(JSON.stringify(seen[0])).toContain('older turns trimmed');

    const saved = await memory.getMessages('th1');
    const dump = JSON.stringify(saved);
    expect(dump).toContain(`mail: ${MASK}`); // THE failure: the question used to be missing entirely
    expect(dump).not.toContain(SECRET);
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2);
    // RESIDUAL, pinned rather than hidden: the marker the processor APPENDED after the turn is
    // persisted with it. Nothing in reach can rule it out — a message added behind the new turn is
    // indistinguishable from a turn that genuinely contributed two messages, and the insertion case
    // is only decidable (h3 below) because there the turn itself is still identifiable AFTER the
    // insertion. Guessing "trailing system rows are not turns" would be a rule, not evidence. What
    // matters is that it rides ALONGSIDE the question instead of replacing it, and that it grows one
    // row per turn rather than compounding (measured to turn 5: 4 markers, all 5 questions intact).
    expect(saved[saved.length - 2]).toMatchObject({ role: 'system', content: '[older turns trimmed]' });
    // …and since the turn WAS recoverable, no loss may be reported.
    const rec: any = await journal.get(runKeys.memoryContext('h1-b'));
    expect(rec.incomingUnrecoverable).toBeUndefined();
    // 2 = question + the appended marker, i.e. exactly what was persisted. regression.ts slices this
    // many TRAILING messages off the frozen input to isolate the turn, so the count has to agree with
    // the split rather than with the caller's intent — asserted end-to-end in the replay test below.
    expect(rec.incomingCount).toBe(2);
    const frozen: any = await journal.get(runKeys.input('h1-b'));
    expect(frozen.messages.slice(-rec.incomingCount)[0]).toMatchObject({ content: `mail: ${MASK}` });
  });

  it('a processor that INJECTS context ahead of the first turn → the injection is not persisted', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // The ordinary RAG shape: prepend retrieved context, pass the rest through (identity preserved).
    const rag: Processor = {
      name: 'rag',
      processInput: (i) => ({ ...i, messages: [{ role: 'system' as const, content: '[retrieved doc]' }, ...(i.messages ?? [])] }),
    };
    const seen: any[] = [];
    const model = () => createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('tamam'); });
    const opts = { journal, memory, threadId: 'th2', processors: [rag] } as const;

    await runDurable({ ...opts, runId: 'h2-a', model: model(), prompt: 'soru-1' });

    // On an EMPTY thread the boundary is 0, and "boundary 0 ⇒ everything the chain produced is this
    // turn" used to win over the identity evidence that says otherwise. A retrieval artifact is
    // regenerated every turn; writing it into the thread is not just wrong, it COMPOUNDS.
    const afterOne = await memory.getMessages('th2');
    expect(JSON.stringify(afterOne)).not.toContain('retrieved doc');
    expect(afterOne.length).toBe(2); // question + answer, nothing else

    await runDurable({ ...opts, runId: 'h2-b', model: model(), prompt: 'soru-2' });
    // The compounding, stated as behavior: the model must see the injected doc ONCE per turn.
    expect(JSON.stringify(seen[1]).split('retrieved doc').length - 1).toBe(1);
    expect(JSON.stringify(await memory.getMessages('th2'))).not.toContain('retrieved doc');
    expect((await memory.getMessages('th2')).length).toBe(4);
  });

  it('a processor that inserts a row BETWEEN history and the new turn → only the turn is persisted', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // Identity of the first incoming message is the ONLY signal that survives this shape: the
    // history side is untouched (so a history anchor points one row too early, swallowing the
    // insertion) and the count changed (so the positional shortcut does not apply).
    const insertBeforeTurn: Processor = {
      name: 'insert-before-turn',
      processInput: (i) => {
        const m = i.messages;
        if (!m || m.length < 2) return i;
        return { ...i, messages: [...m.slice(0, -1), { role: 'system' as const, content: '[just-in-time hint]' }, m[m.length - 1]] };
      },
    };
    const opts = { journal, memory, threadId: 'th3', processors: [insertBeforeTurn] } as const;

    await runDurable({ ...opts, runId: 'h3-a', model: replyModel('bir'), prompt: 'ilk soru' });
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('iki'); });
    await runDurable({ ...opts, runId: 'h3-b', model, prompt: 'ikinci soru' });

    expect(JSON.stringify(seen[0])).toContain('just-in-time hint'); // the insertion really happened
    const saved = await memory.getMessages('th3');
    expect(JSON.stringify(saved)).toContain('ikinci soru');
    expect(JSON.stringify(saved)).not.toContain('just-in-time hint');
    expect(saved.length).toBe(4);
  });

  it('a question REPEATED from earlier in the thread → the live turn wins, not its older twin', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // Rebuild every message (identity gone) and append a note (count changed) → the only evidence
    // left is the SHAPE of the new turn, and the thread contains an identical earlier copy of it.
    // Searching that shape from the START matches the old twin and everything after it — the whole
    // history — gets re-persisted as "this turn". Searching from the END finds the live turn.
    const rebuildAndNote: Processor = {
      name: 'rebuild-and-note',
      processInput: (i) => ({
        ...i,
        messages: [...(i.messages ?? []).map((m: any) => ({ role: m.role, content: m.content })), { role: 'system', content: '[nb]' }],
      }),
    };
    const opts = { journal, memory, threadId: 'th4', processors: [rebuildAndNote] } as const;

    await runDurable({ ...opts, runId: 'h4-a', model: replyModel('bir'), prompt: 'ayni soru' });
    await runDurable({ ...opts, runId: 'h4-b', model: replyModel('iki'), prompt: 'ayni soru' });

    const saved = await memory.getMessages('th4');
    // Two turns asked, two questions stored — not the history folded back in on top of itself.
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(2);
    expect(saved.filter((m: any) => m?.role === 'assistant').length).toBe(2);
  });
});

// The other side of the turn. The boundary says where the turn STARTS; everything behind it used to
// count as the turn, so a processor that appends its own row — a compliance reminder, a marker — got
// that row written into the thread as if the user had sent it. Measured over 10 turns before the fix:
// 30 messages in memory of which 10 were the processor's note (33% of rows, +83% of characters), and
// because the note is STORED it comes back as history and a fresh one is appended on top — the model
// saw the reminder once on turn 1 and TEN times on turn 10. See trackTurnEnd.
describe('the turn ENDS where the caller stopped writing: rows the chain appends behind it', () => {
  const NOTE = '[policy reminder: do not disclose internal pricing]';
  /** The compliance shape: append a reminder behind whatever the caller sent, every turn. */
  const complianceNote: Processor = {
    name: 'compliance',
    processInput: (i) => ({ ...i, messages: [...(i.messages ?? []), { role: 'system' as const, content: NOTE }] }),
  };

  it('10 turns of an appending processor → the note reaches the MODEL every turn and the thread never', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('cevap'); });
    for (let n = 1; n <= 10; n++) {
      await runDurable({ journal, memory, threadId: 'e1', processors: [complianceNote], runId: `e1-${n}`, model, prompt: `soru-${n}` });
    }

    const saved = await memory.getMessages('e1');
    // What the processor is FOR still happens: the model sees the reminder on the last turn…
    expect(JSON.stringify(seen[9])).toContain(NOTE);
    // …exactly ONCE, not once per turn ever taken. This is the compounding: it was 10 before the fix.
    expect(JSON.stringify(seen[9]).split(NOTE).length - 1).toBe(1);
    // The thread holds the conversation and nothing else: 10 questions + 10 answers, no notes.
    expect(JSON.stringify(saved)).not.toContain(NOTE);
    expect(saved.length).toBe(20);
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(10);
  });

  it('`:memctx` stays true to the FROZEN INPUT: the appended row is counted there and named', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'e2', processors: [complianceNote] } as const;
    await runDurable({ ...opts, runId: 'e2-a', model: replyModel('bir'), prompt: 'ilk soru' });
    await runDurable({ ...opts, runId: 'e2-b', model: replyModel('iki'), prompt: 'ikinci soru' });

    const rec: any = await journal.get(runKeys.memoryContext('e2-b'));
    // incomingCount counts the frozen input's trailing block — question + the appended note — because
    // that is the contract regression.ts's stripMemoryContext slices with. chainAppended says how many
    // of those were the chain's, so "what memory holds" is readable as incomingCount - chainAppended.
    expect(rec.incomingCount).toBe(2);
    expect(rec.chainAppended).toBe(1);
    expect(rec.incomingUnrecoverable).toBeUndefined();
    const frozen: any = await journal.get(runKeys.input('e2-b'));
    expect(frozen.messages.slice(-rec.incomingCount)[0]).toMatchObject({ content: 'ikinci soru' });
    // …and the memory-off replay still isolates the turn instead of replaying a slice of history.
    const prompts: any[] = [];
    const probe = createMockModel(async ({ prompt }: any) => { prompts.push(prompt); return finalTextResult('cf'); });
    await replayRun({ journal: journal as any, runId: 'e2-b', model: probe, stripMemoryContext: true });
    expect(JSON.stringify(prompts[0])).toContain('ikinci soru');
    expect(JSON.stringify(prompts[0])).not.toContain('ilk soru');
  });

  it('a CHAIN of redact + append, in EITHER order → masked question in memory, note nowhere', async () => {
    // Each link is tracked separately, which is what makes the pair work in both orders:
    //   redact → append: the redactor rewrites every object but holds the layout (so the span holds),
    //                    then the appender spreads those objects (identity intact → the end is found).
    //   append → redact: the appender's row is excluded first, then the redactor's unchanged layout
    //                    KEEPS it excluded — the narrowed end is carried, not recomputed from scratch.
    for (const [order, chain] of [['redact→append', [redactor, complianceNote]], ['append→redact', [complianceNote, redactor]]] as const) {
      const journal = new InMemoryJournal();
      const memory = new BasicMemory(journal);
      const opts = { journal, memory, threadId: 'e3', processors: chain as Processor[] } as const;
      await runDurable({ ...opts, runId: 'e3-a', model: replyModel('bir'), prompt: 'ilk soru' });
      await runDurable({ ...opts, runId: 'e3-b', model: replyModel('iki'), prompt: `mail: ${SECRET}` });

      const dump = await threadDump(memory, 'e3');
      expect(dump, order).toContain(`mail: ${MASK}`);
      expect(dump, order).not.toContain(SECRET);
      expect(dump, order).not.toContain(NOTE);
      expect((await memory.getMessages('e3')).length, order).toBe(4);
    }
  });

  it('a processor that RESTATES the question at the end → identity keeps the copy out of the thread', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // The "repeat the request last" prompt pattern: the appended row is a byte-identical COPY of the
    // turn's last message, so SHAPE alone cannot tell the two apart (searched from the end it matches
    // the copy) — identity can, and that is why it is tried first. Shape-only would store the question
    // twice, and it would double again every turn as the thread reloads.
    const restate: Processor = {
      name: 'restate',
      processInput: (i) => {
        const m = i.messages ?? [];
        if (!m.length) return i;
        return { ...i, messages: [...m, { ...m[m.length - 1] }] };
      },
    };
    const opts = { journal, memory, threadId: 'e9', processors: [restate] } as const;
    await runDurable({ ...opts, runId: 'e9-a', model: replyModel('bir'), prompt: 'ilk soru' });
    await runDurable({ ...opts, runId: 'e9-b', model: replyModel('iki'), prompt: 'ikinci soru' });

    const saved = await memory.getMessages('e9');
    expect(saved.filter((m: any) => JSON.stringify(m).includes('ikinci soru')).length).toBe(1);
    expect(saved.length).toBe(4);
  });

  it('ONE processor that rebuilds every object AND appends → the note is still located, by SHAPE', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // Normalize-and-remind in a single pass: identity is gone for every message, so the end can only
    // be found by shape — which works here because normalization does not change the TEXT. (When the
    // same pass also rewrites the text, nothing is left to match: that residual is pinned in the
    // net-zero-trim test above.)
    const normalizeAndNote: Processor = {
      name: 'normalize-and-note',
      processInput: (i) => ({
        ...i,
        messages: [...(i.messages ?? []).map((m: any) => ({ role: m.role, content: m.content })), { role: 'system', content: NOTE }],
      }),
    };
    const opts = { journal, memory, threadId: 'e8', processors: [normalizeAndNote] } as const;
    await runDurable({ ...opts, runId: 'e8-a', model: replyModel('bir'), prompt: 'ilk soru' });
    await runDurable({ ...opts, runId: 'e8-b', model: replyModel('iki'), prompt: 'ikinci soru' });

    const dump = await threadDump(memory, 'e8');
    expect(dump).toContain('ikinci soru');
    expect(dump).not.toContain(NOTE);
    expect((await memory.getMessages('e8')).length).toBe(4);
  });

  it('COUNTER-EXAMPLE (the veto): a processor that REORDERS the turn keeps every caller message', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // A normalizer that puts the per-turn instruction BEFORE the final user message (some providers
    // want it that way). The caller's LAST message therefore ends up in the MIDDLE of its own turn,
    // and cutting the span at it would drop the message that follows. The count veto — "a span may
    // not come out shorter than the number of messages the caller contributed" — refuses that
    // evidence and the old whole-tail behavior stands. Without the veto the last row is lost.
    const swapLastTwo: Processor = {
      name: 'instruction-before-question',
      processInput: (i) => {
        const m = i.messages ?? [];
        if (m.length < 2) return i;
        return { ...i, messages: [...m.slice(0, -2), m[m.length - 1], m[m.length - 2]] };
      },
    };
    const opts = { journal, memory, threadId: 'e4', processors: [swapLastTwo] } as const;
    await runDurable({ ...opts, runId: 'e4-a', model: replyModel('bir'), prompt: 'ilk soru' });
    await runDurable({
      ...opts, runId: 'e4-b', model: replyModel('iki'),
      messages: [
        { role: 'user', content: 'ikinci soru' },
        { role: 'user', content: 'ek bilgi' },
        { role: 'system', content: 'kısa cevapla' },
      ],
    });

    const dump = await threadDump(memory, 'e4');
    expect(dump).toContain('ikinci soru');
    expect(dump).toContain('kısa cevapla');
    expect(dump).toContain('ek bilgi'); // THE row a veto-less cut would drop
    const rec: any = await journal.get(runKeys.memoryContext('e4-b'));
    expect(rec.chainAppended).toBeUndefined(); // no row was claimed as chain product
    expect(rec.incomingCount).toBe(3);
  });

  it('COUNTER-EXAMPLE (why the count may not LOCATE): a row inserted INSIDE a two-message turn', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // Reading the count as "the turn is the first N rows of the span" would keep [msg1, note] and drop
    // msg2 — caller content silently replaced by processor output. Located instead: the turn's last
    // message is still last, so the span is unchanged and the insertion rides along inside it.
    const insertInside: Processor = {
      name: 'insert-inside',
      processInput: (i) => {
        const m = i.messages ?? [];
        if (m.length < 2) return i;
        return { ...i, messages: [...m.slice(0, -1), { role: 'system' as const, content: '[araya]' }, m[m.length - 1]] };
      },
    };
    const opts = { journal, memory, threadId: 'e5', processors: [insertInside] } as const;
    await runDurable({
      ...opts, runId: 'e5-a', model: replyModel('bir'),
      messages: [{ role: 'user', content: 'birinci parça' }, { role: 'user', content: 'ikinci parça' }],
    });

    const dump = await threadDump(memory, 'e5');
    expect(dump).toContain('birinci parça');
    expect(dump).toContain('ikinci parça'); // THE failure a count-locator would produce: this one gone
  });

  it('the shipped processor shapes (redact + trim-oldest + moderation) behave exactly as before', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    // tokenLimiter's trim-oldest shape (filter, protects system + the last user message) and a
    // moderation pass-through — neither appends, so the end ladder must be a no-op for both.
    const trimOldest: Processor = {
      name: 'trim-oldest',
      processInput: (i) => {
        const m = i.messages ?? [];
        if (m.length <= 4) return i;
        const lastUser = m.map((x: any) => x?.role).lastIndexOf('user');
        return { ...i, messages: m.filter((x: any, idx: number) => idx > 0 || x?.role === 'system' || idx === lastUser) };
      },
    };
    const moderation: Processor = { name: 'moderation', processInput: (i) => i };
    const chain = [redactor, trimOldest, moderation];
    const runs = async (procs: Processor[] | undefined, thread: string) => {
      for (let n = 1; n <= 5; n++) {
        await runDurable({ journal, memory, threadId: thread, ...(procs ? { processors: procs } : {}), runId: `${thread}-${n}`, model: replyModel(`c${n}`), prompt: `soru-${n}` });
      }
      return memory.getMessages(thread);
    };
    const withChain = await runs(chain, 'e6');
    const without = await runs(undefined, 'e7');
    // Same thread, message for message — the chain rewrites content, it never adds or removes rows.
    expect(withChain.map((m: any) => m.role)).toEqual(without.map((m: any) => m.role));
    expect(withChain.length).toBe(10);
    for (const runId of ['e6-1', 'e6-5']) {
      const rec: any = await journal.get(runKeys.memoryContext(runId));
      expect(rec.chainAppended).toBeUndefined(); // nothing claimed as chain product
      expect(rec.incomingCount).toBe(1);
    }
  });
});
