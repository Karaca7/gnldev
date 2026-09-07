// Six silent-loss / wrong-write paths through the incoming-boundary machinery, each measured on real
// runDurable/streamDurable with a real BasicMemory before it was closed. The companion suite
// (processor-memory-redaction.test.ts) pins what the boundary GETS RIGHT; this one pins the ways it
// used to be wrong QUIETLY — a thread that ends up holding an answer to a question it does not
// contain, or holding somebody else's message as the question, with `:memctx` reporting success.
//
// Every assertion below is on BEHAVIOR: what a thread read returns, what the model was called with,
// what the frozen `:input` + `:memctx` let regression.ts replay. None of them looks at an index or at
// which internal signal fired.
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
/** The shipped piiRedactor shape: pure, deterministic, new objects, layout untouched. */
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
const replyModel = (text = 'ok') => createMockModel(async () => finalTextResult(text));
const forbiddenModel = () => createMockModel(async () => { throw new Error('403 Forbidden'); });
const streamParts = (text: string) => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '1' },
  { type: 'text-delta', id: '1', delta: text },
  { type: 'text-end', id: '1' },
  { type: 'finish', finishReason: 'stop', usage },
];
const dumpOf = async (memory: BasicMemory, threadId: string) => JSON.stringify(await memory.getMessages(threadId));

// ---------------------------------------------------------------------------------------------
// K1 — the input is frozen, so the chain is SKIPPED; `rest` was the caller's raw array.
// ---------------------------------------------------------------------------------------------
describe('a same-runId re-entry runs on the FROZEN input, never on the caller’s raw messages', () => {
  it('the retry’s model call is masked, and carries the question ONCE', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    const boom = createMockModel(async ({ prompt }: any) => { seen.push(prompt); throw new Error('403 Forbidden'); });
    const ok = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('ok'); });
    const opts = { journal, memory, threadId: 'r1', processors: [redactor] } as const;

    // Attempt 1 freezes `:input` (masked) and write-ahead-appends the masked question, then dies.
    await expect(runDurable({ ...opts, runId: 'r1-1', model: boom, prompt: `SORU ${SECRET}` })).rejects.toThrow('403');
    // Attempt 2, SAME runId — the chain must not run again, so what it is handed matters.
    await runDurable({ ...opts, runId: 'r1-1', model: ok, prompt: `SORU ${SECRET}` });

    // THE measured failure: attempt 2 called the provider with the caller's raw address, because
    // prepareMemoryContext had just rebuilt `rest.messages` out of the raw arguments while
    // applyInputProcessors skipped the chain on the frozen `:input`.
    expect(JSON.stringify(seen[1])).not.toContain(SECRET);
    // …and it used to carry the question TWICE (the masked copy loaded from the thread + the raw
    // re-concat), which is a second, independent defect of the same line.
    expect(JSON.stringify(seen[1]).split('SORU').length - 1).toBe(1);
    // The thread is unharmed and the question is stored exactly once, still masked.
    const saved = await memory.getMessages('r1');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1);
    expect(JSON.stringify(saved)).not.toContain(SECRET);
    expect(JSON.stringify(saved)).toContain(MASK);
  });

  it('stream parity — streamDurable’s retry is masked too', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    const opts = { journal, memory, threadId: 'r2', processors: [redactor] } as const;
    await expect(runDurable({ ...opts, runId: 'r2-1', model: forbiddenModel(), prompt: `SORU ${SECRET}` })).rejects.toThrow('403');

    // Hand-rolled rather than createMockStreamModel: its second parameter is a call COUNTER, not a
    // prompt hook, so recording through it would leave `seen` empty and make the assertion below
    // pass on a model that was never called — a proven sham.
    const base = createMockStreamModel(streamParts('ok'));
    const model = { ...base, doStream: async (o: any) => { seen.push(o.prompt); return base.doStream(o); } };

    const r = await streamDurable({ ...opts, runId: 'r2-1', model, prompt: `SORU ${SECRET}` });
    await r.text;
    expect(seen.length).toBe(1); // the capture really ran
    expect(JSON.stringify(seen)).not.toContain(SECRET);
    expect(JSON.stringify(seen)).toContain(MASK);
    expect(await dumpOf(memory, 'r2')).not.toContain(SECRET);
  });

  it('when the write-ahead never landed, the retry stores the MASKED question — not the raw one', async () => {
    // The window the two-phase `memUserAppended` marker exists for: `:input` froze, the process died
    // before the memory append. The retry re-enters with a raw `incoming` and a skipped chain, and
    // this is the case where the marker cannot save memory either — nothing had claimed it yet.
    // Measured before the fix: `RAW PII IN MEMORY? true · MODEL SAW RAW? true`.
    class DieOnMemCtx extends InMemoryJournal {
      armed = false;
      async put(key: string, value: unknown): Promise<void> {
        if (this.armed && key.endsWith(':memctx')) { this.armed = false; throw new Error('disk gone'); }
        return super.put(key, value as any);
      }
    }
    const journal = new DieOnMemCtx();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('ok'); });
    const opts = { journal, memory, threadId: 'r3', processors: [redactor] } as const;

    await runDurable({ ...opts, runId: 'r3-seed', model: replyModel('H2'), prompt: 'H1' });
    journal.armed = true;
    await expect(runDurable({ ...opts, runId: 'r3-1', model, prompt: `SORU ${SECRET}` })).rejects.toThrow('disk gone');
    // `:input` really did freeze, masked, while the thread never got the question.
    expect(JSON.stringify(await journal.get(runKeys.input('r3-1')))).toContain(MASK);
    expect(await dumpOf(memory, 'r3')).not.toContain('SORU');

    await runDurable({ ...opts, runId: 'r3-1', model, prompt: `SORU ${SECRET}` });

    expect(await dumpOf(memory, 'r3')).not.toContain(SECRET); // memory
    expect(JSON.stringify(seen)).not.toContain(SECRET);       // and the provider
    // The `:memctx` write is what died, so nothing records where the turn sits inside the frozen
    // input — the turn is refused rather than guessed at, and that has to be visible.
    expect(warn.mock.calls.flat().join(' ')).toContain('no recoverable copy of this turn');
    expect(((await journal.get(runKeys.memoryContext('r3-1'))) as any).incomingUnrecoverable).toBe('boundary-lost');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// K4 — the END was vetoed against the caller's message count; the START was not.
// ---------------------------------------------------------------------------------------------
describe('the turn span may not be narrowed from the START either', () => {
  /** Verbatim the processor the companion suite already pins as the reorder counter-example. */
  const swapLastTwo: Processor = {
    name: 'instruction-before-question',
    processInput: (i) => {
      const m = i.messages ?? [];
      if (m.length < 2) return i;
      return { ...i, messages: [...m.slice(0, -2), m[m.length - 1], m[m.length - 2]] };
    },
  };

  it('a TWO-message turn survives the same reorder a three-message turn already did', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'v1', processors: [swapLastTwo] } as const;
    await runDurable({ ...opts, runId: 'v1-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({
      ...opts, runId: 'v1-b', model: replyModel('two'),
      messages: [{ role: 'user', content: 'second question' }, { role: 'system', content: 'answer briefly' }],
    });

    const dump = await dumpOf(memory, 'v1');
    expect(dump).toContain('second question');
    // THE failure: the swap moved the caller's FIRST message last, the boundary followed it there,
    // and the row it stepped over fell onto the history side — gone from the thread, `:memctx`
    // reading `incomingCount: 1` as if one message were all the caller sent, and no warning.
    expect(dump).toContain('answer briefly');
    const rec: any = await journal.get(runKeys.memoryContext('v1-b'));
    expect(rec.incomingCount).toBe(2); // both rows, counted against the frozen input
    expect(rec.incomingUnrecoverable).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('an EMPTY span is still `turn-dropped`, not a narrowing — the veto must not swallow it', async () => {
    // The exemption that keeps the veto honest: `end === start` means the chain removed the turn,
    // which has its own (loud) report. Turning that into a boundary loss would rename a real defect.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dropNewest: Processor = {
      name: 'drop-newest',
      processInput: (i) => (i.messages && i.messages.length > 1 ? { ...i, messages: i.messages.slice(0, -1) } : i),
    };
    const opts = { journal, memory, threadId: 'v2', processors: [redactor, dropNewest] } as const;
    await runDurable({ ...opts, runId: 'v2-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({ ...opts, runId: 'v2-b', model: replyModel('two'), prompt: `mail: ${SECRET}` });

    expect(warn.mock.calls.flat().join(' ')).toContain('turn-dropped');
    expect(await dumpOf(memory, 'v2')).not.toContain(SECRET);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// K5 — the write-ahead dedupe was believing the chain's own output.
// ---------------------------------------------------------------------------------------------
describe('dropping a turn as "already stored" needs the LOADED history to say so', () => {
  /** "Repeat the request last", in the shape-only form: every object rebuilt, the turn restated. */
  const rebuildAndRestate: Processor = {
    name: 'rebuild-and-restate',
    processInput: (i) => {
      const m = (i.messages ?? []).map((x: any) => ({ role: x.role, content: x.content }));
      if (!m.length) return { ...i, messages: m };
      return { ...i, messages: [...m, { role: m[m.length - 1].role, content: m[m.length - 1].content }] };
    },
  };

  it('a chain that RESTATES the turn does not thereby delete it', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'w1', processors: [rebuildAndRestate] } as const;
    await runDurable({ ...opts, runId: 'w1-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({ ...opts, runId: 'w1-b', model: replyModel('two'), prompt: 'second question' });

    // THE failure: the boundary landed on the restated copy, the row in front of it was the chain's
    // OWN first copy, `historyEndsWithIncoming` matched that and dropped the turn as a retry —
    // thread ["ilk soru","ilk soru","bir","iki"], stamped `incomingDedupedByShape` (which reads
    // "duplicate", not "lost"), the second question nowhere and no warning.
    expect(await dumpOf(memory, 'w1')).toContain('second question');
    const rec: any = await journal.get(runKeys.memoryContext('w1-b'));
    expect(rec.incomingDedupedByShape).toBeUndefined();
    expect(rec.incomingUnrecoverable).toBeUndefined();
  });

  it('the GENUINE retry dedupe still fires — the fix adds a witness, it does not remove the rule', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'w2', processors: [redactor] } as const;
    // Attempt 1 dies after the write-ahead → the thread tail IS the masked question.
    await expect(runDurable({ ...opts, runId: 'w2-a', model: forbiddenModel(), prompt: `mail: ${SECRET}` })).rejects.toThrow('403');
    // A different raw address that redacts to the same string: indistinguishable from a retry, and
    // memory really does end with it — both witnesses agree, so the drop is still correct.
    await runDurable({ ...opts, runId: 'w2-b', model: replyModel('ok'), prompt: 'mail: baska@ornek.com' });

    const saved = await memory.getMessages('w2');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1);
    expect(((await journal.get(runKeys.memoryContext('w2-b'))) as any).incomingDedupedByShape).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// K6 — `incomingCount` is a promise about the FROZEN INPUT, and the dedupe branch truncates it.
// ---------------------------------------------------------------------------------------------
describe('`:memctx.incomingCount` counts the frozen input as it was actually frozen', () => {
  it('a deduped retry under an APPENDING chain does not hand regression.ts an earlier turn', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const note: Processor = {
      name: 'policy-note',
      processInput: (i) => ({ ...i, messages: [...(i.messages ?? []), { role: 'system' as const, content: '[NOTE]' }] }),
    };
    const opts = { journal, memory, threadId: 'x1', processors: [redactor, note] } as const;
    await runDurable({ ...opts, runId: 'x1-a', model: replyModel('BIRINCI-CEVAP'), prompt: 'first question' });
    await expect(runDurable({ ...opts, runId: 'x1-b', model: forbiddenModel(), prompt: `mail: ${SECRET}` })).rejects.toThrow('403');
    await runDurable({ ...opts, runId: 'x1-c', model: replyModel('two'), prompt: 'mail: baska@ornek.com' });

    const rec: any = await journal.get(runKeys.memoryContext('x1-c'));
    const frozen: any = await journal.get(runKeys.input('x1-c'));
    // The dedupe drops the re-concat AND the chain's appended row, so the frozen input is shorter
    // than the array the count was taken from. Measured before the fix: incomingCount 2 against a
    // 3-row frozen input, so the slice reached back into turn 1.
    const isolated = JSON.stringify(frozen.messages.slice(-rec.incomingCount));
    expect(isolated).toContain(`mail: ${MASK}`);
    expect(isolated).not.toContain('BIRINCI-CEVAP');
    expect(isolated).not.toContain('[NOTE]');
    // …asserted end-to-end, since the slice only matters because replay uses it.
    const prompts: any[] = [];
    const probe = createMockModel(async ({ prompt }: any) => { prompts.push(prompt); return finalTextResult('cf'); });
    await replayRun({ journal: journal as any, runId: 'x1-c', model: probe, stripMemoryContext: true });
    expect(JSON.stringify(prompts[0])).toContain(`mail: ${MASK}`);
    expect(JSON.stringify(prompts[0])).not.toContain('BIRINCI-CEVAP'); // somebody else's turn, replayed as this one
  });
});

// ---------------------------------------------------------------------------------------------
// K8 — rows the chain puts INSIDE the turn are stored, and used to be unaccounted for.
// ---------------------------------------------------------------------------------------------
describe('rows the chain contributes inside the turn are counted, so the thread stays auditable', () => {
  const insertInside: Processor = {
    name: 'insert-inside',
    processInput: (i) => {
      const m = i.messages ?? [];
      if (m.length < 2) return i;
      return { ...i, messages: [...m.slice(0, -1), { role: 'system' as const, content: '[araya]' }, m[m.length - 1]] };
    },
  };

  it('`chainInserted` names the rows a mid-turn insertion accumulates in the thread', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'y1', processors: [insertInside] } as const;
    for (let n = 1; n <= 3; n++) {
      await runDurable({ ...opts, runId: `y1-${n}`, model: replyModel(`c${n}`), messages: [{ role: 'user', content: `a${n}` }, { role: 'user', content: `b${n}` }] });
    }
    const saved = await memory.getMessages('y1');
    // The accumulation itself is the documented trade (the caller's own rows are around it, so no
    // evidence separates them) — what was missing is any record OF it. `chainAppended` says nothing
    // here by construction: the insertion is not behind the turn.
    expect(saved.filter((m: any) => JSON.stringify(m).includes('[araya]')).length).toBe(3);
    const rec: any = await journal.get(runKeys.memoryContext('y1-3'));
    expect(rec.incomingCount).toBe(3);
    expect(rec.chainAppended).toBeUndefined();
    expect(rec.chainInserted).toBe(1); // 3 stored rows, 2 of them the caller's
  });

  it('a chain that only rewrites claims nothing — the field is absent on every clean run', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'y2', processors: [redactor] } as const;
    await runDurable({ ...opts, runId: 'y2-a', model: replyModel('one'), prompt: `mail: ${SECRET}` });
    const rec: any = await journal.get(runKeys.memoryContext('y2-a'));
    expect(rec.chainInserted).toBeUndefined();
    expect(rec.chainAppended).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// Signal 7 (COUNT UNCHANGED, unguarded) — removed. It was a coin flip, and it lost quietly.
// ---------------------------------------------------------------------------------------------
describe('a chain that leaves no evidence reports the loss instead of guessing positionally', () => {
  /** Rewrite every message (identity + shape gone), rotate, same count, roles moved. */
  const rewriteAndRotate = (dir: 'left' | 'right'): Processor => ({
    name: `rewrite-rotate-${dir}`,
    processInput: (i) => {
      const m = (i.messages ?? []).map((x: any) => ({ role: x.role, content: `<${JSON.stringify(x.content)}>` }));
      if (m.length < 2) return { ...i, messages: m };
      return { ...i, messages: dir === 'right' ? [m[m.length - 1], ...m.slice(0, -1)] : [...m.slice(1), m[0]] };
    },
  });

  it('the permutation that used to store a HISTORY assistant row as the user’s turn now says so', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'z1', processors: [rewriteAndRotate('right')] } as const;
    await runDurable({ ...opts, runId: 'z1-a', model: replyModel('ASISTAN-CEVABI'), prompt: 'first question' });
    await runDurable({ ...opts, runId: 'z1-b', model: replyModel('two'), prompt: 'second question' });

    const saved = await memory.getMessages('z1');
    // THE failure: with the count unchanged and no evidence at all, the old index was handed back and
    // whatever the rotation left there — a rewritten copy of turn 1's ASSISTANT reply — was written
    // into the thread as turn 2's question. `incomingCount: 1`, no stamp, no warning.
    expect(saved.filter((m: any) => m?.role === 'user' && JSON.stringify(m).includes('ASISTAN-CEVABI')).length).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('boundary-lost');
    expect(((await journal.get(runKeys.memoryContext('z1-b'))) as any).incomingUnrecoverable).toBe('boundary-lost');
    warn.mockRestore();
  });

  it('…and its mirror image, which the same rule used to get right BY LUCK, is reported the same way', async () => {
    // Stated plainly because it is the cost of the removal: this permutation left the turn at the old
    // index, so the positional guess happened to be correct and now the turn is refused instead.
    // A rule with counter-examples in both directions is not a rule — the same standard this file
    // applies to the count-as-locator and the tail-clamp.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'z2', processors: [rewriteAndRotate('left')] } as const;
    await runDurable({ ...opts, runId: 'z2-a', model: replyModel('one'), prompt: 'first question' });
    const seen: any[] = [];
    const model = createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult('two'); });
    await runDurable({ ...opts, runId: 'z2-b', model, prompt: 'second question' });

    // The stamp and the warning say a turn was refused; these say WHAT the thread and the model
    // actually ended up with, which is the part a stamp cannot promise. The refusal has to cost the
    // QUESTION and nothing else: the answer is still stored, no row of turn 1 is duplicated into
    // turn 2, and above all the RAW pre-chain message is not quietly persisted as the fallback.
    const saved = await memory.getMessages('z2');
    const dump = JSON.stringify(saved);
    expect(dump.split('first question').length - 1).toBe(1); // turn 1's question, once — not re-persisted
    expect(dump).not.toContain('second question');         // refused, and NOT written raw either
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(1);
    expect(dump).toContain('two');                     // the answer is there — an answer with no question
    // The model did see the question (that is what makes the loss a loss, not a no-op).
    expect(JSON.stringify(seen[0])).toContain('second question');
    expect(((await journal.get(runKeys.memoryContext('z2-b'))) as any).incomingUnrecoverable).toBe('boundary-lost');
    expect(((await journal.get(runKeys.memoryContext('z2-b'))) as any).incomingCount).toBe(0);
    expect(warn.mock.calls.flat().join(' ')).toContain('no recoverable copy of this turn');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// dropEchoedHistory — an assistant PREFILL is not an echo.
// ---------------------------------------------------------------------------------------------
describe('an assistant prefill ends a turn; it does not erase one', () => {
  it('a turn ending in an assistant prefill is persisted, not trimmed to nothing', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'p1' } as const;
    await runDurable({ ...opts, runId: 'p1-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({
      ...opts, runId: 'p1-b', model: replyModel('two'),
      messages: [{ role: 'user', content: 'second question' }, { role: 'assistant', content: 'Cevap:' }],
    });

    // THE failure: the echo rule anchored on the turn's OWN last message, the slice came out empty,
    // and the question was gone with `incomingCount: 0`, `echoTrimmed: 2` and no warning — a thread
    // holding an answer to a question it does not contain. No processors involved: this predates them.
    const dump = await dumpOf(memory, 'p1');
    expect(dump).toContain('second question');
    expect(dump).toContain('Cevap:');
    const rec: any = await journal.get(runKeys.memoryContext('p1-b'));
    expect(rec.incomingCount).toBe(2);
    expect(rec.echoTrimmed).toBe(0);
  });

  it('the echo trim itself still works, prefill or no prefill (the F1 contract)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'p2' } as const;
    await runDurable({ ...opts, runId: 'p2-a', model: replyModel('one'), prompt: 'first question' });
    const saved = await memory.getMessages('p2');
    // A useChat-style client POSTs the WHOLE history back, then the new turn — and here also a
    // prefill behind it. Only the two new rows may be persisted; the echo must still be stripped.
    await runDurable({
      ...opts, runId: 'p2-b', model: replyModel('two'),
      messages: [...saved, { role: 'user', content: 'second question' }, { role: 'assistant', content: 'Cevap:' }],
    });
    const after = await memory.getMessages('p2');
    expect(after.length).toBe(5); // 2 (turn 1) + question + prefill + answer — nothing re-persisted
    expect(after.filter((m: any) => JSON.stringify(m).includes('first question')).length).toBe(1);
    const rec: any = await journal.get(runKeys.memoryContext('p2-b'));
    expect(rec.echoTrimmed).toBe(2);
    expect(rec.incomingCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------------------------
// The shipped chain must be byte-for-byte what it was. None of the above may cost it anything.
// ---------------------------------------------------------------------------------------------
describe('the shipped chain (piiRedactor + tokenLimiter + moderation) is unchanged by all of this', () => {
  const tokenLimiter: Processor = {
    name: 'token-limit',
    processInput: (i) => {
      const m = i.messages ?? [];
      if (m.length <= 4) return i;
      const lastUser = m.map((x: any) => x?.role).lastIndexOf('user');
      return { ...i, messages: m.filter((x: any, idx: number) => idx > 0 || x?.role === 'system' || idx === lastUser) };
    },
  };
  const moderation: Processor = { name: 'moderation', processInput: (i) => i };

  it('10 turns with the chain and 10 without produce the same thread, and the same `:memctx`', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const run = async (procs: Processor[] | undefined, thread: string) => {
      for (let n = 1; n <= 10; n++) {
        await runDurable({
          journal, memory, threadId: thread, ...(procs ? { processors: procs } : {}),
          runId: `${thread}-${n}`, model: replyModel(`reply-${n}`), prompt: `question-${n}`,
        });
      }
      return memory.getMessages(thread);
    };
    const withChain = await run([redactor, tokenLimiter, moderation], 'sc1');
    const without = await run(undefined, 'sc2');

    expect(withChain.length).toBe(20);
    expect(withChain.map((m: any) => m.role)).toEqual(without.map((m: any) => m.role));
    expect(JSON.stringify(withChain)).toBe(JSON.stringify(without)); // same content, message for message
    for (let n = 1; n <= 10; n++) {
      const a: any = await journal.get(runKeys.memoryContext(`sc1-${n}`));
      const b: any = await journal.get(runKeys.memoryContext(`sc2-${n}`));
      expect(a.incomingCount, `turn ${n}`).toBe(b.incomingCount);
      expect(a.echoTrimmed, `turn ${n}`).toBe(b.echoTrimmed);
      expect(a.chainAppended, `turn ${n}`).toBeUndefined();
      expect(a.chainInserted, `turn ${n}`).toBeUndefined();
      expect(a.incomingUnrecoverable, `turn ${n}`).toBeUndefined();
      expect(a.incomingDedupedByShape, `turn ${n}`).toBeUndefined();
    }
  });

  it('…and it still masks, on the first turn, on a later turn, and on a same-runId retry', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    const chain = [redactor, tokenLimiter, moderation];
    const opts = { journal, memory, threadId: 'sc3', processors: chain } as const;
    const spy = () => createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult(`cevap ${SECRET}`); });

    await runDurable({ ...opts, runId: 'sc3-1', model: spy(), prompt: `first ${SECRET}` });
    await runDurable({ ...opts, runId: 'sc3-2', model: spy(), prompt: `second ${SECRET}` });
    await expect(runDurable({ ...opts, runId: 'sc3-3', model: forbiddenModel(), prompt: `ucuncu ${SECRET}` })).rejects.toThrow('403');
    await runDurable({ ...opts, runId: 'sc3-3', model: spy(), prompt: `ucuncu ${SECRET}` });

    expect(JSON.stringify(seen)).not.toContain(SECRET);      // every model call
    expect(await dumpOf(memory, 'sc3')).not.toContain(SECRET); // and the thread, questions and answers
    const saved = await memory.getMessages('sc3');
    expect(saved.filter((m: any) => m?.role === 'user').length).toBe(3); // three turns, none duplicated
    expect(saved.length).toBe(6);
  });
});
