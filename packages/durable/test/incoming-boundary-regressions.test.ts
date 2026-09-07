// The defects an audit board found in the boundary/frozen-input hardening itself, each measured on
// real runDurable/streamDurable with a real BasicMemory before it was closed. Same standard as the
// two companion suites (processor-memory-redaction.test.ts pins what the machinery gets right,
// processor-boundary-hardening.test.ts pins the silent losses it used to have): every assertion is
// on BEHAVIOR — what a thread read returns, what the model was called with, what `:memctx` promises
// a replay — and never on an index or on which internal signal fired.
import { describe, it, expect, vi } from 'vitest';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { runDurable, streamDurable } from '../src/run.js';
import { readRunOutcome } from '../src/outcome.js';
import { RunThreadMismatchError } from '../src/errors.js';
import type { Processor } from '../src/processor.js';
import { createMockModel, createMockStreamModel, finalTextResult } from './mock.js';

/**
 * A journal that dies once when the write-ahead tries to CLAIM its append marker — the only way to
 * reach the frozen-input adoption's memory half from a test. With a healthy journal the write-ahead
 * lands on attempt 1 and the retry finds the turn already in the thread, so there is nothing left to
 * locate; failing the memory append instead leaves a fresh `pending` claim behind, which the retry
 * correctly reads as another worker being in flight. Dying before the claim leaves `:input` and
 * `:memctx` frozen and the thread untouched — exactly the window this machinery exists for.
 */
class DieOnWriteAhead extends InMemoryJournal {
  armed = true;
  async putIfAbsent(key: string, value: unknown): Promise<boolean> {
    if (this.armed && key.startsWith('mem-user-appended:')) { this.armed = false; throw new Error('disk gone'); }
    return super.putIfAbsent(key, value as any);
  }
}

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
};

const replyModel = (text = 'ok') => createMockModel(async () => finalTextResult(text));
const dumpOf = async (memory: BasicMemory, threadId: string) => JSON.stringify(await memory.getMessages(threadId));
/** Records every prompt the provider was handed; optionally dies like a 403 would. */
function capturingModel(seen: any[], text: string, fail = false) {
  return createMockModel(async ({ prompt }: any) => {
    seen.push(prompt);
    if (fail) throw new Error('403 Forbidden');
    return finalTextResult(text);
  });
}
const occurrences = (haystack: string, needle: string) => haystack.split(needle).length - 1;
/** A useChat-style POST: the client's own view of the conversation (plain string content). */
const asPosted = (rows: any[]) =>
  rows.map((m: any) => ({
    role: m.role,
    content: typeof m.content === 'string' ? m.content : (m.content ?? []).map((p: any) => p?.text ?? '').join(''),
  }));

// ---------------------------------------------------------------------------------------------
// G1 — a frozen input belongs to ONE thread.
// ---------------------------------------------------------------------------------------------
describe('a frozen `:input` is adopted only by the thread it was frozen for', () => {
  it('a same-runId re-entry on a DIFFERENT thread never shows the model the other thread’s history', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, processors: [redactor] } as const;
    const seen: any[] = [];

    // Thread A builds private history, then a run under runId 'shared' freezes A's whole context.
    await runDurable({ ...opts, threadId: 'A', runId: 'a-seed', model: replyModel('A-CEVAP'), prompt: 'A-OZEL-SIR' });
    await expect(
      runDurable({ ...opts, threadId: 'A', runId: 'shared', model: capturingModel([], 'x', true), prompt: 'A-SORUSU' }),
    ).rejects.toThrow('403');

    // The SAME runId now arrives carrying thread B's own question.
    await expect(
      runDurable({ ...opts, threadId: 'B', runId: 'shared', model: capturingModel(seen, 'c'), prompt: 'B-SORUSU' }),
    ).rejects.toThrow(/runId "shared" was started for thread "A"/);

    // THE leak: `rest.messages = frozen.messages` handed thread A's private transcript to the
    // provider on a run the caller scoped to thread B. The provider is not called at all now.
    expect(seen.length).toBe(0);
    // …and the other half of the same line: the answer was appended to thread B while B's question
    // was written nowhere (the write-ahead marker belongs to thread A's attempt). Refusing keeps the
    // thread consistent instead — it holds neither half of a turn that could not be served.
    expect(await dumpOf(memory, 'B')).toBe('[]');
    expect(await dumpOf(memory, 'A')).not.toContain('B-SORUSU');
  });

  it('a run frozen WITHOUT a thread, or re-entered without one, is still the same run', async () => {
    // The complement of the rule: a missing `threadId` on either side is not a collision. Neither of
    // these may be refused, and both must run on the FROZEN (masked) input.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    // Frozen without memory/thread, re-entered WITH one.
    await expect(
      runDurable({ journal, processors: [redactor], runId: 'n1', model: capturingModel([], 'x', true), prompt: `question ${SECRET}` }),
    ).rejects.toThrow('403');
    await runDurable({ journal, memory, threadId: 'N', processors: [redactor], runId: 'n1', model: capturingModel(seen, 'ok'), prompt: `question ${SECRET}` });
    expect(JSON.stringify(seen[0])).toContain(MASK);

    // Frozen WITH a thread, re-entered without memory at all.
    const seen2: any[] = [];
    await expect(
      runDurable({ journal, memory, threadId: 'N2', processors: [redactor], runId: 'n2', model: capturingModel([], 'x', true), prompt: `question ${SECRET}` }),
    ).rejects.toThrow('403');
    await runDurable({ journal, processors: [redactor], runId: 'n2', model: capturingModel(seen2, 'ok'), prompt: `question ${SECRET}` });
    expect(JSON.stringify(seen2[0])).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// G2 — the prefill exception must not read a REGENERATE as a new turn.
// ---------------------------------------------------------------------------------------------
describe('a client that re-POSTs its history WITHOUT a new user row is regenerating, not prefilling', () => {
  it('the last turn is not persisted a second time, nor shown to the model twice', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'c1' } as const;
    await runDurable({ ...opts, runId: 'c1-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({ ...opts, runId: 'c1-b', model: replyModel('two'), prompt: 'second question' });
    const before = await memory.getMessages('c1');
    expect(before.length).toBe(4);

    // useChat's "regenerate": the whole conversation is POSTed back and NO new user row is added.
    const seen: any[] = [];
    await runDurable({ ...opts, runId: 'c1-c', model: capturingModel(seen, 'two-again'), messages: asPosted(before) });

    // THE failure: the role scan skipped the trailing assistant row as if it were a prefill, anchored
    // on the PREVIOUS assistant, and read the already-stored last turn as brand new — the thread grew
    // by three rows and the model saw the last turn twice.
    const after = await memory.getMessages('c1');
    expect(after.length).toBe(before.length + 1); // only the new answer
    expect(occurrences(JSON.stringify(after), 'second question')).toBe(1);
    expect(occurrences(JSON.stringify(seen[0]), 'second question')).toBe(1);
    const rec: any = await journal.get(runKeys.memoryContext('c1-c'));
    expect(rec.incomingCount).toBe(0);
    expect(rec.echoTrimmed).toBe(before.length);
  });

  it('“continue generating” — the POST ends with the stored assistant turn, still nothing new', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'c5' } as const;
    await runDurable({ ...opts, runId: 'c5-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({ ...opts, runId: 'c5-b', model: replyModel('two'), prompt: 'second question' });
    const before = await memory.getMessages('c5');
    const seen: any[] = [];
    await runDurable({ ...opts, runId: 'c5-c', model: capturingModel(seen, 'continued'), messages: asPosted(before) });
    expect(occurrences(await dumpOf(memory, 'c5'), 'second question')).toBe(1);
    expect((await memory.getMessages('c5')).length).toBe(before.length + 1); // only the continuation
    expect(occurrences(JSON.stringify(seen[0]), 'second question')).toBe(1);
  });

  it('a client-side TOOL result resent on its own adds no user turn', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'c6' } as const;
    await runDurable({ ...opts, runId: 'c6-a', model: replyModel('one'), prompt: 'first question' });
    const before = await memory.getMessages('c6');
    await runDurable({
      ...opts, runId: 'c6-b', model: replyModel('two'),
      messages: [...asPosted(before), { role: 'tool', content: [{ type: 'tool-result', toolCallId: 't1', toolName: 'x', output: { type: 'text', value: 'ok' } }] }],
    });
    // Nothing the client sent is a new user turn, so no user row may appear twice.
    expect(occurrences(await dumpOf(memory, 'c6'), 'first question')).toBe(1);
    const rec: any = await journal.get(runKeys.memoryContext('c6-b'));
    expect(rec.incomingCount).toBe(0);
  });

  it('…while a NEW user turn followed by a client-side tool round IS persisted (the flow the skip fixed)', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const opts = { journal, memory, threadId: 'c7' } as const;
    await runDurable({ ...opts, runId: 'c7-a', model: replyModel('one'), prompt: 'first question' });
    const before = await memory.getMessages('c7');
    await runDurable({
      ...opts, runId: 'c7-b', model: replyModel('two'),
      messages: [
        ...asPosted(before),
        { role: 'user', content: 'second question' },
        { role: 'assistant', content: 'Cevap:' },
      ],
    });
    const dump = await dumpOf(memory, 'c7');
    expect(dump).toContain('second question');
    expect(dump).toContain('Cevap:');
    expect(occurrences(dump, 'first question')).toBe(1); // the echo is still trimmed
    const rec: any = await journal.get(runKeys.memoryContext('c7-b'));
    expect(rec.incomingCount).toBe(2);
    expect(rec.echoTrimmed).toBe(before.length);
  });
});

// ---------------------------------------------------------------------------------------------
// G3 — a turn that legitimately gets SHORTER is not a lost boundary.
// ---------------------------------------------------------------------------------------------
describe('a processor that legitimately SHRINKS the turn still stores it', () => {
  /** Summarizer/compactor shape: the trailing run of user rows is merged into one. */
  const collapseTrailingUsers: Processor = {
    name: 'collapse-trailing-users',
    processInput: (i) => {
      const m = i.messages ?? [];
      let k = m.length;
      while (k > 0 && m[k - 1]?.role === 'user') k--;
      if (m.length - k < 2) return i;
      const merged = { role: 'user', content: `SUMMARY(${m.slice(k).map((x: any) => String(x.content)).join(' | ')})` };
      return { ...i, messages: [...m.slice(0, k), merged] };
    },
  };
  /** Moves per-turn `system` rows into the `system` FIELD — a very common normalizer. */
  const hoistSystem: Processor = {
    name: 'hoist-system',
    processInput: (i) => {
      const m = i.messages ?? [];
      const sys = m.filter((x: any) => x?.role === 'system');
      if (sys.length === 0) return i;
      return {
        prompt: i.prompt,
        system: [i.system, ...sys.map((x: any) => String(x.content))].filter(Boolean).join('\n'),
        messages: m.filter((x: any) => x?.role !== 'system'),
      };
    },
  };
  /** Filters blank rows — identity-preserving, like every `filter`-shaped processor. */
  const dropBlank: Processor = {
    name: 'drop-blank',
    processInput: (i) => ({ ...i, messages: (i.messages ?? []).filter((m: any) => String(m?.content ?? '').trim() !== '') }),
  };
  /** The shipped tokenLimiter's shape under a budget tight enough to cut INTO the turn. */
  const hardTrimmer: Processor = {
    name: 'hard-trimmer',
    processInput: (i) => {
      const m = i.messages ?? [];
      let last = -1;
      for (let k = m.length - 1; k >= 0; k--) if (m[k]?.role === 'user') { last = k; break; }
      return { ...i, messages: m.filter((_x: any, k: number) => k === last) };
    },
  };

  it('a summarizer that merges three question rows into one, on a thread WITH history', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'g1', processors: [collapseTrailingUsers] } as const;
    await runDurable({ ...opts, runId: 'g1-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({
      ...opts, runId: 'g1-b', model: replyModel('two'),
      messages: [
        { role: 'user', content: 'second question' },
        { role: 'user', content: 'ek bilgi' },
        { role: 'user', content: 'son not' },
      ],
    });

    // THE failure: `start` and `end` were both located correctly, and the width veto threw them away
    // because the turn came out SHORTER than the caller's own row count — `boundary-lost`,
    // `incomingCount: 0`, and a thread holding an answer whose question is missing.
    const dump = await dumpOf(memory, 'g1');
    expect(dump).toContain('second question');
    expect(dump).toContain('son not');
    const rec: any = await journal.get(runKeys.memoryContext('g1-b'));
    expect(rec.incomingUnrecoverable).toBeUndefined();
    expect(rec.incomingCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('…and the same summarizer on the FIRST turn of an empty thread', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await runDurable({
      journal, memory, threadId: 'g2', runId: 'g2-a', processors: [collapseTrailingUsers], model: replyModel('one'),
      messages: [
        { role: 'user', content: 'second question' },
        { role: 'user', content: 'ek bilgi' },
        { role: 'user', content: 'son not' },
      ],
    });
    expect(await dumpOf(memory, 'g2')).toContain('second question');
    const rec: any = await journal.get(runKeys.memoryContext('g2-a'));
    expect(rec.incomingUnrecoverable).toBeUndefined();
    expect(rec.incomingCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a normalizer that hoists a per-turn `system` row into the system field', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'g3', processors: [hoistSystem] } as const;
    await runDurable({ ...opts, runId: 'g3-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({
      ...opts, runId: 'g3-b', model: replyModel('two'),
      messages: [{ role: 'user', content: 'second question' }, { role: 'system', content: 'answer briefly' }],
    });
    expect(await dumpOf(memory, 'g3')).toContain('second question');
    const rec: any = await journal.get(runKeys.memoryContext('g3-b'));
    expect(rec.incomingUnrecoverable).toBeUndefined();
    expect(rec.incomingCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a filter that drops a blank row out of the turn', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'g4', processors: [dropBlank] } as const;
    await runDurable({ ...opts, runId: 'g4-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({
      ...opts, runId: 'g4-b', model: replyModel('two'),
      messages: [{ role: 'user', content: 'second question' }, { role: 'user', content: '   ' }],
    });
    expect(await dumpOf(memory, 'g4')).toContain('second question');
    const rec: any = await journal.get(runKeys.memoryContext('g4-b'));
    expect(rec.incomingUnrecoverable).toBeUndefined();
    expect(rec.incomingCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a token budget tight enough to trim INTO the turn keeps the surviving question', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'g5', processors: [hardTrimmer] } as const;
    await runDurable({ ...opts, runId: 'g5-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({
      ...opts, runId: 'g5-b', model: replyModel('two'),
      messages: [{ role: 'user', content: 'second question' }, { role: 'user', content: 'son satir' }],
    });
    // The survivor is what the model actually saw, so the survivor is what the thread must hold.
    expect(await dumpOf(memory, 'g5')).toContain('son satir');
    const rec: any = await journal.get(runKeys.memoryContext('g5-b'));
    expect(rec.incomingUnrecoverable).toBeUndefined();
    expect(rec.incomingCount).toBe(1);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// The other side of the same veto: what a narrowing must still REFUSE.
// ---------------------------------------------------------------------------------------------
describe('the width veto still refuses the cuts that lose caller content', () => {
  it('a chain that trims history AND reorders the turn keeps the whole turn', async () => {
    // The end evidence points at the caller's "last" message sitting in the MIDDLE of a reordered
    // turn; cutting there drops the row behind it. Because the chain also changed the count, the
    // over-persisting fallback is not available — the turn has to be kept whole from the end ladder
    // itself, which is what refusing the shrunken `end` does.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const trimAndSwap: Processor = {
      name: 'trim-oldest-and-swap-last-two',
      processInput: (i) => {
        const m = i.messages ?? [];
        if (m.length < 3) return i;
        const kept = m.slice(1);
        return { ...i, messages: [...kept.slice(0, -2), kept[kept.length - 1], kept[kept.length - 2]] };
      },
    };
    const opts = { journal, memory, threadId: 'w1', processors: [trimAndSwap] } as const;
    await runDurable({ ...opts, runId: 'w1-a', model: replyModel('one'), prompt: 'first question' });
    await runDurable({
      ...opts, runId: 'w1-b', model: replyModel('two'),
      messages: [{ role: 'user', content: 'second question' }, { role: 'system', content: 'answer briefly' }],
    });
    const dump = await dumpOf(memory, 'w1');
    expect(dump).toContain('second question');
    expect(dump).toContain('answer briefly'); // THE row a veto-less cut drops
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('a normalizer that hoists a row in FRONT of the history reports the loss instead of re-persisting it', async () => {
    // The fallback's own limit. `[span.start, after.length)` is the turn's tail only while the history
    // sits where it was; a front-hoist shifts everything, so the range opens on a HISTORY row. There is
    // no contiguous span that is this turn (the caller's rows ended up at both ends of the array), and
    // re-persisting the thread's own messages as a new turn is the compounding this file exists to stop.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const hoistToFront: Processor = {
      name: 'system-rows-first',
      processInput: (i) => {
        const m = i.messages ?? [];
        const sys = m.filter((x: any) => x?.role === 'system');
        return sys.length === 0 ? i : { ...i, messages: [...sys, ...m.filter((x: any) => x?.role !== 'system')] };
      },
    };
    const opts = { journal, memory, threadId: 'w2', processors: [hoistToFront] } as const;
    await runDurable({ ...opts, runId: 'w2-a', model: replyModel('one'), prompt: 'FIRST-QUESTION' });
    await runDurable({
      ...opts, runId: 'w2-b', model: replyModel('two'),
      messages: [{ role: 'user', content: 'IKINCI-SORU' }, { role: 'system', content: 'answer briefly' }],
    });
    const dump = await dumpOf(memory, 'w2');
    expect(occurrences(dump, 'FIRST-QUESTION')).toBe(1); // turn 1's question is NOT re-persisted as turn 2
    expect(occurrences(dump, 'one')).toBe(1);      // nor is turn 1's answer
    expect(warn.mock.calls.flat().join(' ')).toContain('boundary-lost');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// G4 — the frozen input is adopted independently of the processor chain.
// ---------------------------------------------------------------------------------------------
describe('a worker without processors still runs a frozen run on the FROZEN input', () => {
  it('attempt 1 with a redactor, attempt 2 without: the provider never sees the raw address', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    await expect(
      runDurable({ journal, memory, threadId: 'b4', runId: 'b4-1', processors: [redactor], model: capturingModel([], 'x', true), prompt: `question ${SECRET}` }),
    ).rejects.toThrow('403');
    // The retry lands on a worker configured WITHOUT processors — same runId, same input.
    await runDurable({ journal, memory, threadId: 'b4', runId: 'b4-1', model: capturingModel(seen, 'ok'), prompt: `question ${SECRET}` });

    // THE failure: `applyInputProcessors` (and therefore the frozen-input adoption inside it) was
    // called only when a chain existed, so the retry rebuilt `rest.messages` from the caller's raw
    // arguments — the masked copy from the thread AND the raw address, both sent to the provider.
    const prompt = JSON.stringify(seen[0]);
    expect(prompt).not.toContain(SECRET);
    expect(prompt).toContain(MASK);
    expect(occurrences(prompt, 'question')).toBe(1);
    expect(await dumpOf(memory, 'b4')).not.toContain(SECRET);
  });
});

// ---------------------------------------------------------------------------------------------
// U3 — the frozen `system` and `prompt` are pinned too, not only `messages`.
// ---------------------------------------------------------------------------------------------
describe('the whole frozen input is adopted — system and prompt as well as messages', () => {
  it('the retry’s SYSTEM prompt is the masked one the first attempt froze', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    const opts = { journal, memory, threadId: 'u3a', processors: [redactor] } as const;
    await expect(
      runDurable({ ...opts, runId: 'u3a-1', model: capturingModel([], 'x', true), prompt: 'question', system: `admin: ${SECRET}` }),
    ).rejects.toThrow('403');
    await runDurable({ ...opts, runId: 'u3a-1', model: capturingModel(seen, 'ok'), prompt: 'question', system: `admin: ${SECRET}` });
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
    expect(JSON.stringify(seen[0])).toContain(MASK);
  });

  it('the retry’s PROMPT is the masked one too (a run without memory keeps `prompt`)', async () => {
    const journal = new InMemoryJournal();
    const seen: any[] = [];
    const opts = { journal, processors: [redactor] } as const;
    await expect(
      runDurable({ ...opts, runId: 'u3b-1', model: capturingModel([], 'x', true), prompt: `question ${SECRET}` }),
    ).rejects.toThrow('403');
    await runDurable({ ...opts, runId: 'u3b-1', model: capturingModel(seen, 'ok'), prompt: `question ${SECRET}` });
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
    expect(JSON.stringify(seen[0])).toContain(MASK);
  });
});

// ---------------------------------------------------------------------------------------------
// U6/U7 — what `:memctx` is allowed to say about the frozen input.
// ---------------------------------------------------------------------------------------------
describe('`:memctx` locates the turn inside the frozen input, and only within its bounds', () => {
  it('a chain-appended note is not re-persisted when the run is re-entered', async () => {
    const journal = new DieOnWriteAhead();
    const memory = new BasicMemory(journal);
    /** Appends a policy reminder BEHIND the turn — the `chainAppended` shape. */
    const noteAppender: Processor = {
      name: 'policy-note',
      processInput: (i) => ({ ...i, messages: [...(i.messages ?? []), { role: 'system', content: '[POLICY NOTE]' }] }),
    };
    const opts = { journal, memory, threadId: 'u7', processors: [redactor, noteAppender] } as const;
    await expect(
      runDurable({ ...opts, runId: 'u7-1', model: replyModel('x'), prompt: 'second question' }),
    ).rejects.toThrow('disk gone');
    expect(await dumpOf(memory, 'u7')).toBe('[]'); // the write-ahead really did not land
    // …so the retry is what writes this turn into the thread — out of the FROZEN input, located with
    // `:memctx`, whose `chainAppended` is what keeps the note on the model's side of the line.
    await runDurable({ ...opts, runId: 'u7-1', model: replyModel('ok'), prompt: 'second question' });

    const dump = await dumpOf(memory, 'u7');
    expect(dump).toContain('second question');
    expect(dump).not.toContain('POLICY NOTE'); // the chain's own row is shown, never stored
  });

  it('a `:memctx` that claims more rows than the frozen input HAS refuses instead of storing history', async () => {
    const journal = new DieOnWriteAhead();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'u6', processors: [redactor] } as const;
    journal.armed = false;
    await runDurable({ ...opts, runId: 'u6-a', model: replyModel('one'), prompt: 'first question' });
    journal.armed = true;
    await expect(
      runDurable({ ...opts, runId: 'u6-1', model: replyModel('x'), prompt: 'second question' }),
    ).rejects.toThrow('disk gone');
    // Corrupt the record the way a stale/partially-written one would be: a count larger than the
    // frozen input's own length. Believing it would slice history rows in as "the turn".
    const rec: any = await journal.get(runKeys.memoryContext('u6-1'));
    expect(rec.incomingCount).toBe(1);
    await journal.put(runKeys.memoryContext('u6-1'), { ...rec, incomingCount: 99 });

    await runDurable({ ...opts, runId: 'u6-1', model: replyModel('ok'), prompt: 'second question' });
    // `first question` is turn 1's question: it may appear ONCE (its own row), never a second time as part
    // of turn 2's incoming block.
    expect(occurrences(await dumpOf(memory, 'u6'), 'first question')).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('no recoverable copy of this turn');
    warn.mockRestore();
  });

  it('a `:memctx` that already reported a LOSS is not used to locate anything', async () => {
    // reportIncomingLoss writes the stamp and zeroes the count together, so the guard only shows up
    // against a record where they DISAGREE — a legacy or half-written one. Believing its count would
    // resurrect exactly the turn the first attempt refused to guess at.
    const journal = new DieOnWriteAhead();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'u5b', processors: [redactor] } as const;
    journal.armed = false;
    await runDurable({ ...opts, runId: 'u5b-a', model: replyModel('one'), prompt: 'first question' });
    journal.armed = true;
    await expect(
      runDurable({ ...opts, runId: 'u5b-1', model: replyModel('x'), prompt: 'second question' }),
    ).rejects.toThrow('disk gone');
    const rec: any = await journal.get(runKeys.memoryContext('u5b-1'));
    await journal.put(runKeys.memoryContext('u5b-1'), { ...rec, incomingUnrecoverable: 'boundary-lost', incomingCount: 2 });

    await runDurable({ ...opts, runId: 'u5b-1', model: replyModel('ok'), prompt: 'second question' });
    // A count of 2 against a 3-row frozen input would have sliced turn 1's answer in as the question.
    expect(occurrences(await dumpOf(memory, 'u5b'), 'one')).toBe(1);
    expect(warn.mock.calls.flat().join(' ')).toContain('no recoverable copy of this turn');
    warn.mockRestore();
  });

  it('a `:memctx` written for ANOTHER thread never locates this turn', async () => {
    const journal = new DieOnWriteAhead();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const opts = { journal, memory, threadId: 'u5', processors: [redactor] } as const;
    await expect(
      runDurable({ ...opts, runId: 'u5-1', model: replyModel('x'), prompt: 'second question' }),
    ).rejects.toThrow('disk gone');
    const rec: any = await journal.get(runKeys.memoryContext('u5-1'));
    await journal.put(runKeys.memoryContext('u5-1'), { ...rec, threadId: 'BASKA-THREAD' });

    await runDurable({ ...opts, runId: 'u5-1', model: replyModel('ok'), prompt: 'second question' });
    // The record describes a conversation this run is not having, so it cannot say where the turn is.
    expect(warn.mock.calls.flat().join(' ')).toContain('no recoverable copy of this turn');
    expect(((await journal.get(runKeys.memoryContext('u5-1'))) as any).threadId).toBe('BASKA-THREAD');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// G5 — a frozen `prompt` re-entered with memory attached is not a dropped turn.
// ---------------------------------------------------------------------------------------------
describe('a run frozen WITHOUT memory, re-entered WITH memory', () => {
  it('the masked prompt is the turn — it is stored, and no loss is reported', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Attempt 1: no memory at all, so `:input` freezes a masked `prompt` and no `:memctx` exists.
    await expect(
      runDurable({ journal, processors: [redactor], runId: 'g5p-1', model: capturingModel([], 'x', true), prompt: `question ${SECRET}` }),
    ).rejects.toThrow('403');
    expect(await journal.get(runKeys.memoryContext('g5p-1'))).toBeUndefined();

    // Attempt 2 lands on a worker that DOES have memory wired up.
    const seen: any[] = [];
    await runDurable({ journal, memory, threadId: 'g5p', processors: [redactor], runId: 'g5p-1', model: capturingModel(seen, 'ok'), prompt: `question ${SECRET}` });

    // THE failure: the frozen input has no `messages` array, so the turn was reported
    // `messages-dropped` and the thread kept the answer with no question — while a perfectly usable,
    // MASKED copy of the turn sat in the frozen `prompt`.
    const dump = await dumpOf(memory, 'g5p');
    expect(dump).toContain(MASK);
    expect(dump).not.toContain(SECRET);
    expect(JSON.stringify(seen[0])).not.toContain(SECRET);
    expect(warn.mock.calls.flat().join(' ')).not.toContain('no recoverable copy of this turn');
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// G6 — the G1 thread-ownership rejection is a HARD rejection: refusing the call must leave the
// run's own history untouched. Three regressions an audit found in the refusal itself (not in what
// it refuses): it flipped an already-COMPLETED run's outcome to 'failed' (K2), it journaled the
// caller's `approvals` for a call that was never evaluated (K3), and it threw a bare `Error` with no
// typed `name`/`detail` for the HTTP layer to key off (K4). All three trace to ONE ordering bug: the
// mismatch used to be caught inside applyInputProcessors, AFTER runStarted and resolveApprovals had
// already written to the journal. The fix reads `:input` and asserts ownership FIRST — see
// `assertThreadOwnership` in run.ts.
// ---------------------------------------------------------------------------------------------
describe('G1 thread-ownership rejection: a HARD reject must not corrupt state it never touched', () => {
  it('K2: a COMPLETED run keeps reading completed after a later mismatched-thread call is rejected', async () => {
    const journal = new InMemoryJournal();
    const model = replyModel('ok');

    await runDurable({ journal, runId: 'g6-1', threadId: 'A', model, prompt: 'first question' });
    expect((await readRunOutcome(journal, 'g6-1'))?.status).toBe('completed');

    // Same runId, WRONG thread — must be refused, and must not touch run 'g6-1's own verdict.
    await expect(
      runDurable({ journal, runId: 'g6-1', threadId: 'B', model, prompt: 'baska thread' }),
    ).rejects.toThrow(/owns one conversation/);

    expect((await readRunOutcome(journal, 'g6-1'))?.status).toBe('completed');
  });

  it('K2 (streamDurable parity): same guarantee on the streaming entry point', async () => {
    const journal = new InMemoryJournal();
    // A STREAMING mock: `replyModel` is doGenerate-only and its `doStream` throws, so streaming
    // through it never produces a verdict to protect in the first place.
    const model = () => createMockStreamModel([
      { type: 'stream-start', warnings: [] },
      { type: 'text-start', id: '1' },
      { type: 'text-delta', id: '1', delta: 'ok' },
      { type: 'text-end', id: '1' },
      { type: 'finish', finishReason: { unified: 'stop', raw: 'stop' }, usage: {
        inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      } },
    ]);

    // CONSUME the stream. `streamDurable` returns as soon as the stream EXISTS; the 'completed'
    // verdict is written by onFinish, which cannot run until the stream is drained. Waiting a tick
    // instead leaves the run at 'running' — and the assertion below would then be measuring that,
    // not the rejection this test is about.
    const first: any = await streamDurable({ journal, runId: 'g6-2', threadId: 'A', model: model(), prompt: 'first question' });
    for await (const _ of first.fullStream) { /* drain: onFinish runs at the end of this */ }
    expect((await readRunOutcome(journal, 'g6-2'))?.status, 'PRECONDITION: the first run completed').toBe('completed');

    await expect(
      streamDurable({ journal, runId: 'g6-2', threadId: 'B', model: model(), prompt: 'baska thread' }),
    ).rejects.toThrow(/owns one conversation/);

    expect((await readRunOutcome(journal, 'g6-2'))?.status).toBe('completed');
  });

  it('K3: the approvals parameter of a rejected mismatched-thread call is never journaled', async () => {
    const journal = new InMemoryJournal();
    const model = replyModel('ok');

    await runDurable({ journal, runId: 'g6-3', threadId: 'A', model, prompt: 'first question' });
    await expect(
      runDurable({
        journal, runId: 'g6-3', threadId: 'B', model, prompt: 'baska thread',
        approvals: { 'never-evaluated-call': true },
      }),
    ).rejects.toThrow(/owns one conversation/);

    // A decision recorded here would be a decision for a tool call this attempt never reached.
    expect(await journal.get(runKeys.approval('g6-3', 'never-evaluated-call'))).toBeUndefined();
  });

  it('K4: the rejection is a typed RunThreadMismatchError (name + detail), not a bare Error', async () => {
    const journal = new InMemoryJournal();
    const model = replyModel('ok');

    await runDurable({ journal, runId: 'g6-4', threadId: 'A', model, prompt: 'first question' });
    let caught: unknown;
    try {
      await runDurable({ journal, runId: 'g6-4', threadId: 'B', model, prompt: 'baska thread' });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RunThreadMismatchError);
    const err = caught as RunThreadMismatchError;
    expect(err.name).toBe('RunThreadMismatchError');
    expect(err.detail).toEqual({ runId: 'g6-4', startedForThread: 'A', requestedThread: 'B' });
  });
});

// ---------------------------------------------------------------------------------------------
// G7 — a regenerate under an INPUT PROCESSOR costs the same as one without.
//
// `dropEchoedHistory` asks whether the client just echoed back what the thread already holds. The
// thread holds the chain's OUTPUT (masked); the client re-POSTs its own transcript (RAW); the chain
// has not run yet at that point. So the two sides were never comparable and every regenerate read as
// new. It was documented as costing "a duplicate row"; measured, the cost GREW per turn, because each
// unmatched turn left more unmatched history for the next one to re-append.
// ---------------------------------------------------------------------------------------------
describe('an input processor does not make a regenerate grow the thread', () => {
  const SORU = `question ${SECRET}`;
  /** Four regenerates, the client re-POSTing the RAW transcript it holds — what a real client has. */
  async function growth(procs: Processor[]): Promise<number[]> {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    await runDurable({ journal, memory, threadId: 't', processors: procs, runId: 'seed', model: replyModel('cevap'), prompt: SORU });
    const counts = [(await memory.getMessages('t')).length];
    let raw: any[] = [{ role: 'user', content: SORU }, { role: 'assistant', content: 'cevap' }];
    for (let i = 1; i <= 4; i++) {
      await runDurable({ journal, memory, threadId: 't', processors: procs, runId: `re-${i}`, model: replyModel('cevap'), messages: raw as never });
      raw = [...raw, { role: 'assistant', content: 'cevap' }];
      counts.push((await memory.getMessages('t')).length);
    }
    return counts;
  }

  it('the thread grows by ONE row per regenerate, redactor or not', async () => {
    const bare = await growth([]);
    // PRECONDITION: without processors a regenerate appends exactly the new answer. If this drifts,
    // the comparison below is against the wrong baseline and proves nothing.
    expect(bare, 'PRECONDITION: the no-processor baseline is one row per regenerate').toEqual([2, 3, 4, 5, 6]);

    const masked = await growth([redactor]);
    // Measured before the echo view existed: [2, 5, 9, 14, 20] — +3, +4, +5, +6.
    expect(masked, 'a regenerate under a redactor re-appended the turn').toEqual(bare);
  });

  it('and the thread still holds only the MASKED text', async () => {
    // The echo view is a comparison, not a substitution: what gets stored is still the chain's output.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    await runDurable({ journal, memory, threadId: 't2', processors: [redactor], runId: 's', model: replyModel('cevap'), prompt: SORU });
    await runDurable({
      journal, memory, threadId: 't2', processors: [redactor], runId: 'r1', model: replyModel('cevap'),
      messages: [{ role: 'user', content: SORU }, { role: 'assistant', content: 'cevap' }] as never,
    });
    const dump = await dumpOf(memory, 't2');
    expect(dump, 'the raw address reached the thread').not.toContain(SECRET);
    expect(dump).toContain(MASK);
  });
});

describe('the echo view survives a processor that uses ctx.journal', () => {
  it('a processor calling a journal method beyond get/put still gets the fixed cost', async () => {
    // The dry run is handed a journal that swallows the report write, and how that stand-in is BUILT
    // matters. Spreading the real one (`{...journal, get, put}`) copies own fields only, so every
    // prototype method is left behind — measured on `InMemoryJournal`: `get`/`put` survive because
    // they are written here, and `putIfAbsent`/`putIfMatch`/`incrBy` do not. `ctx.step` is NOT the way
    // in (it is a get+put memoize, so it works either way — an earlier version of this comment claimed
    // otherwise and the mutation proved it wrong); `ctx.journal` is, because it is public API and a
    // processor may call anything on it. Such a processor would throw, the view's catch would swallow
    // it, and the fix would degrade to the raw rows: present, paid for, doing nothing.
    let reached = 0;
    const journaling: Processor = {
      name: 'journaling',
      processInput: async (i, ctx) => {
        await ctx.journal.putIfAbsent!(`probe:${ctx.runId}:${reached++}`, { seen: true });
        return {
          system: typeof i.system === 'string' ? redactText(i.system) : i.system,
          prompt: typeof i.prompt === 'string' ? redactText(i.prompt) : i.prompt,
          messages: i.messages ? i.messages.map(redactMessage) : i.messages,
        };
      },
    };
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const SORU = `question ${SECRET}`;
    await runDurable({ journal, memory, threadId: 's1', processors: [journaling], runId: 'seed', model: replyModel('cevap'), prompt: SORU });
    const counts = [(await memory.getMessages('s1')).length];
    let raw: any[] = [{ role: 'user', content: SORU }, { role: 'assistant', content: 'cevap' }];
    for (let n = 1; n <= 3; n++) {
      await runDurable({ journal, memory, threadId: 's1', processors: [journaling], runId: `re-${n}`, model: replyModel('cevap'), messages: raw as never });
      raw = [...raw, { role: 'assistant', content: 'cevap' }];
      counts.push((await memory.getMessages('s1')).length);
    }

    expect(reached, 'PRECONDITION: the processor never reached ctx.journal, so this proves nothing').toBeGreaterThan(0);
    expect(counts, 'the echo view degraded to the raw rows behind a journal-using processor').toEqual([2, 3, 4, 5]);
    expect(await dumpOf(memory, 's1'), 'the raw address reached the thread').not.toContain(SECRET);
  });
});

/**
 * G8 — an echo is a SUFFIX of the thread, not a bag of rows that each appear somewhere.
 *
 * The membership test was a `Set` over the whole history, so a row counted as "already sent" if it
 * matched ANY stored row at ANY position. Redaction exists to collapse distinct texts onto one token,
 * which makes that collision ordinary rather than exotic — and the comparison only became reachable
 * once the echo view made masked rows comparable at all. Measured: a genuinely new question that
 * masked identically to an older one was read as an echo and dropped whole.
 */
describe('a new turn that only RESEMBLES a stored one is not an echo', () => {
  it('a question that masks to the same text as an older one still reaches the model and the thread', async () => {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const seen: any[] = [];
    const capturing = () => createMockModel(async ({ prompt }: any) => { seen.push(prompt); return finalTextResult(`cevap${seen.length}`); });

    // Turn 1 stores `soru [MASKED_EMAIL]`.
    await runDurable({ journal, memory, threadId: 'x1', processors: [redactor], runId: 'r1', model: capturing(), prompt: 'soru a@x.com' });
    expect((await memory.getMessages('x1')).length, 'PRECONDITION: turn 1 stored one question and one answer').toBe(2);

    // Turn 2 asks something DIFFERENT that masks to the identical string, and carries a client-side
    // tool round — the trailing block that sends this down the echo branch.
    await runDurable({
      journal, memory, threadId: 'x1', processors: [redactor], runId: 'r2', model: capturing(),
      messages: [
        { role: 'user', content: 'soru b@y.com' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: '{}' }] },
        { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'c1', toolName: 'x', output: { type: 'text', value: 'ok' } }] },
      ] as never,
    });

    // Measured before: the model was handed turn 1's history only, and the thread ended with TWO
    // assistant rows under ONE user row — the question was in neither place.
    const rows = await memory.getMessages('x1');
    expect(rows.filter((m: any) => m.role === 'user').length, 'the second question was dropped from the thread').toBe(2);
    expect(occurrences(JSON.stringify(seen[1]), MASK), 'the model was never shown the second question').toBe(2);
    expect(JSON.stringify(rows), 'the raw address reached the thread').not.toContain('b@y.com');
  });
});

/**
 * G9 — the echo view transforms only the rows the INPUT chain is what stored.
 *
 * A user row reaches the thread through `processInput`, so the masked copy is what to compare against.
 * A model's own reply does not: it is stored through `processOutput`, or raw when the processor
 * defines only an input hook — which is what `on: 'input'` means. Masking assistant rows in the
 * comparison made it miss whenever the MODEL's text contained something the input hook would
 * transform, and the growth this suite exists to stop came straight back.
 */
describe('the echo view does not mask rows the input chain never stored', () => {
  /** `on: 'input'` shape: an input hook and no output hook, so model output is stored raw. */
  const inputOnly: Processor = {
    name: 'input-only',
    processInput: (i) => ({
      system: typeof i.system === 'string' ? redactText(i.system) : i.system,
      prompt: typeof i.prompt === 'string' ? redactText(i.prompt) : i.prompt,
      messages: i.messages ? i.messages.map(redactMessage) : i.messages,
    }),
  };

  async function growth(reply: string): Promise<number[]> {
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const SORU = `question ${SECRET}`;
    await runDurable({ journal, memory, threadId: 'o1', processors: [inputOnly], runId: 'seed', model: replyModel(reply), prompt: SORU });
    const counts = [(await memory.getMessages('o1')).length];
    let raw: any[] = [{ role: 'user', content: SORU }, { role: 'assistant', content: reply }];
    for (let i = 1; i <= 3; i++) {
      await runDurable({ journal, memory, threadId: 'o1', processors: [inputOnly], runId: `re-${i}`, model: replyModel(reply), messages: raw as never });
      raw = [...raw, { role: 'assistant', content: reply }];
      counts.push((await memory.getMessages('o1')).length);
    }
    return counts;
  }

  it('a MODEL reply containing what the input hook would mask does not reopen the growth', async () => {
    // PRECONDITION: a plain reply is the flat baseline. If this drifts the comparison below is against
    // the wrong number.
    expect(await growth('cevap'), 'PRECONDITION: a plain reply grows by one per regenerate').toEqual([2, 3, 4, 5]);
    // Measured before: [2, 5, 9, 14] — the assistant row was masked for the comparison but stored raw.
    expect(await growth(`cevap ${SECRET}`), 'a reply the input hook would touch reopened the growth').toEqual([2, 3, 4, 5]);
  });

  it('a NEW tool result whose text matches an older one is not swallowed', async () => {
    // `incoming` made only of echoable rows leaves the "rows in front of the trailing block" empty, so
    // the coverage guard has nothing to check and a single content match decided the whole POST. Tool
    // outputs like `ok`/`true`/`success` repeat constantly, so this is ordinary traffic.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const toolRow = (id: string) => ({
      role: 'tool',
      content: [{ type: 'tool-result', toolCallId: id, toolName: 'x', output: { type: 'text', value: 'ok' } }],
    });
    await runDurable({
      journal, memory, threadId: 'o2', processors: [inputOnly], runId: 'b1', model: replyModel('ok'),
      messages: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'x', input: '{}' }] },
        toolRow('c1'),
      ] as never,
    });
    expect(JSON.stringify(await memory.getMessages('o2')), 'PRECONDITION: the first round was stored').toContain('c1');

    // A DIFFERENT call's result, same text, sent on its own.
    const seen: any[] = [];
    await runDurable({ journal, memory, threadId: 'o2', processors: [inputOnly], runId: 'b2', model: capturingModel(seen, 'cevap'), messages: [toolRow('c2')] as never });

    // Asserted on the CONTENT, not on the row count: the count rises by one either way, because the
    // model's own answer is appended whether or not the tool result survived. Measured that way first,
    // which is how this read as fixed while the result was still being dropped.
    expect(JSON.stringify(await memory.getMessages('o2')), 'the new tool result was read as an echo and dropped from the thread').toContain('c2');
    expect(JSON.stringify(seen[0]), 'the model was never shown the new tool result').toContain('c2');
  });
});

describe('@gnldev/durable exports what its CHANGELOG says it exports', () => {
  it('RunThreadMismatchError is reachable from the package entry, not just from errors.js', async () => {
    // The typed error is announced as the way a host maps this rejection instead of matching a string.
    // It was absent from the barrel: `import { RunThreadMismatchError } from '@gnldev/durable'` gave
    // `undefined`, and the documented `instanceof` check threw `TypeError`. Nothing caught it — the
    // suite, typecheck and doc samples all reach errors.js directly, the way no consumer can.
    const entry: Record<string, unknown> = await import('../src/index.js');
    expect(Object.keys(entry), 'the barrel does not re-export it').toContain('RunThreadMismatchError');
    const Cls = entry.RunThreadMismatchError as new (m: string, d: unknown) => Error;
    const err = new Cls('x', { runId: 'r', startedForThread: 'A', requestedThread: 'B' });
    expect(err instanceof Cls, 'the documented instanceof check does not work').toBe(true);
    expect(err.name).toBe('RunThreadMismatchError');
  });
});
