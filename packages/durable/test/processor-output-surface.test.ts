// What an OUTPUT processor governs on the CALLER's side — and, stated just as plainly, what it does not.
//
// The starting measurement, one redactor installed on both entry points, same prompt, same reply:
//
//   runDurable      result.text                'cevap: [MASKED_EMAIL]'   masked
//                   result.response.messages   masked
//                   result.steps               RAW
//                   result.content             RAW
//   streamDurable   result.text                'cevap: gizli@ornek.com'  RAW      ← the leak
//                   result.response.messages   RAW
//                   result.steps               RAW
//                   result.content             RAW
//
// The stream row is the serious one and it is the one this suite closes: `text` is the single most
// read field on a result, and a caller who uses `streamDurable` for its durability and then does
// `logger.info(await result.text)` was handed exactly what the processor exists to remove — while
// the byte-identical code under `runDurable` was not. Only the messages heading for MEMORY were
// being processed; everything returned to the caller was the model's own output.
//
// `steps`/`content` stay RAW on BOTH paths, and that is pinned here rather than left to be
// rediscovered. `processOutput({text, messages}) -> {text, messages}` is called ONCE with the whole
// turn and its output arity is unconstrained (see the ARITY test below: a summariser legally returns
// one message for three), so there is no total function mapping the result back onto
// `steps[i].response.messages` — and `content` is a different structure again. Masking only the
// cases where the arity happens to line up would be an illusion, which is worse than a documented
// raw field. Closing it properly needs a hook that owns step records; that is a processor-contract
// change, not something this layer can patch.
import { describe, it, expect, vi } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { BasicMemory } from '../src/memory.js';
import { runDurable, streamDurable } from '../src/run.js';
import { RunLimitExceededError } from '../src/limits.js';
import type { Processor } from '../src/processor.js';
import type { Guard } from '../src/guard.js';
import { createMockModel, createMockStreamModel, finalTextResult } from './mock.js';

const SECRET = 'gizli@ornek.com';
const MASK = '[MASKED_EMAIL]';
const EMAIL = /[\w.+-]+@[\w-]+\.[\w.]+/g;
const REPLY = `cevap: ${SECRET}`;

const redactText = (s: string) => s.replace(EMAIL, MASK);
function redactMessage(m: any): any {
  if (typeof m?.content === 'string') return { ...m, content: redactText(m.content) };
  if (Array.isArray(m?.content)) {
    return { ...m, content: m.content.map((p: any) => (typeof p?.text === 'string' ? { ...p, text: redactText(p.text) } : p)) };
  }
  return m;
}

/**
 * Give any already-scheduled continuation a chance to run, WITHOUT depending on wall-clock time.
 *
 * The tests below assert that a second output-processor pass does NOT happen. A `setTimeout(50)`
 * makes that a race with the machine: under load the 50 ms can elapse before the stray pass was
 * ever scheduled, and the assertion passes for the wrong reason (a false green that gets worse
 * exactly when CI is busiest). A fixed number of event-loop TURNS costs the same on a loaded box as
 * on an idle one, and every path the output pass can be resumed from — promise chains, `await`,
 * queueMicrotask, setImmediate — is drained by it. Both call sites additionally assert, separately,
 * that the work being waited on really completed, so "nothing extra ran" can never be satisfied by
 * "nothing ran at all".
 */
async function drainEventLoop(turns = 25): Promise<void> {
  for (let i = 0; i < turns; i++) await new Promise((r) => setImmediate(r));
}

/** The piiRedactor shape: pure, character-wise, deterministic, both directions. */
function makeRedactor(counter?: { out: number }): Processor {
  return {
    name: 'redactor',
    processOutput: (o) => {
      if (counter) counter.out++;
      return { ...o, text: typeof o.text === 'string' ? redactText(o.text) : o.text, messages: o.messages ? o.messages.map(redactMessage) : o.messages };
    },
  };
}

const raw = (v: unknown) => JSON.stringify(v ?? null).includes(SECRET);

const usage = { inputTokens: 1, outputTokens: 1, totalTokens: 2 };
const textParts = (text: string) => [
  { type: 'stream-start', warnings: [] },
  { type: 'text-start', id: '1' },
  { type: 'text-delta', id: '1', delta: text },
  { type: 'text-end', id: '1' },
  { type: 'finish', finishReason: 'stop', usage },
];

async function waitFor(cond: () => boolean, ms = 1000) {
  const t0 = Date.now();
  while (!cond() && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 5));
}

describe('output processors reach the caller on BOTH paths (stream/generate parity)', () => {
  it('streamDurable: `await result.text` is MASKED — the field the leak was measured on', async () => {
    const journal = new InMemoryJournal();
    const res = await streamDurable({
      runId: 's1', journal, model: createMockStreamModel(textParts(REPLY)),
      processors: [makeRedactor()], prompt: 'soru',
    });
    for await (const _ of res.textStream) { /* an SSE-style consumer */ }

    const text = await res.text;
    // MUTATION PROOF: drop the `mask` argument in guardStreamTerminalPromises (or the `prop === 'text'`
    // branch of maskTerminal) and this is `cevap: gizli@ornek.com` — the measured pre-fix value.
    expect(text).toBe(`cevap: ${MASK}`);
    expect(raw(text)).toBe(false);
  });

  it('streamDurable: the caller who NEVER touches the delta stream still gets masked text', async () => {
    // The whole point. This consumer uses the stream for durability/locking and reads one field.
    const journal = new InMemoryJournal();
    const res = await streamDurable({
      runId: 's2', journal, model: createMockStreamModel(textParts(REPLY)),
      processors: [makeRedactor()], prompt: 'soru',
    });
    await expect(res.text).resolves.toBe(`cevap: ${MASK}`);
  });

  it('streamDurable: `result.response.messages` is masked too (the other half of the {text, messages} view)', async () => {
    const journal = new InMemoryJournal();
    const res = await streamDurable({
      runId: 's3', journal, model: createMockStreamModel(textParts(REPLY)),
      processors: [makeRedactor()], prompt: 'soru',
    });
    const response: any = await res.response;
    expect(raw(response?.messages)).toBe(false);
    expect(JSON.stringify(response?.messages)).toContain(MASK);
  });

  it('the two entry points now agree field-for-field on the surfaces the contract covers', async () => {
    const journal = new InMemoryJournal();
    const gen: any = await runDurable({
      runId: 'p1', journal, model: createMockModel(async () => finalTextResult(REPLY)),
      processors: [makeRedactor()], prompt: 'soru',
    });
    const str: any = await streamDurable({
      runId: 'p2', journal, model: createMockStreamModel(textParts(REPLY)),
      processors: [makeRedactor()], prompt: 'soru',
    });
    for await (const _ of str.textStream) { /* drain */ }

    expect(await str.text).toBe(gen.text);
    expect(raw(gen.response?.messages)).toBe(raw((await str.response)?.messages));
    expect(raw(gen.response?.messages)).toBe(false);
  });

  it('processOutput still runs EXACTLY ONCE per turn, though two consumers now need its result', async () => {
    // The hook's contract is one call with the whole turn. The memory append and the caller-facing
    // promises share a single memoised pass — a second invocation would double-count an audit
    // report and, for a journalling processor, re-ask a decision `ctx.step` has already frozen.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const counter = { out: 0 };
    const res = await streamDurable({
      runId: 's4', journal, memory, threadId: 't4', model: createMockStreamModel(textParts(REPLY)),
      processors: [makeRedactor(counter)], prompt: 'soru',
    });
    for await (const _ of res.textStream) { /* drain */ }
    await res.text;
    await res.response;
    await res.text; // cached getter — must not re-run anything either
    // Wait for the memory append (the OTHER consumer of the pass) to have actually landed —
    // asserted separately, because "0 extra calls" is trivially true if the append never ran.
    let stored: any[] = [];
    const t0 = Date.now();
    while (stored.length < 2 && Date.now() - t0 < 1000) {
      stored = await memory.getMessages('t4');
      if (stored.length < 2) await new Promise((r) => setTimeout(r, 5));
    }
    expect(stored.length).toBe(2);
    // Re-drive every consumer AFTER the append landed: a pass triggered by a late getter access
    // happens HERE, awaited, rather than "probably within 50ms".
    await res.text;
    await res.response;
    await drainEventLoop();

    expect(counter.out).toBe(1);
    expect(raw(stored)).toBe(false); // the append used that same pass
  });

  it('no processors → the result object is handed back untouched (mask is not installed at all)', async () => {
    const journal = new InMemoryJournal();
    const res = await streamDurable({
      runId: 's5', journal, model: createMockStreamModel(textParts(REPLY)), prompt: 'soru',
    });
    await expect(res.text).resolves.toBe(REPLY);
  });
});

describe('masking must not weaken anything the terminal promises already guaranteed', () => {
  const parts = (arr: any[]) => new ReadableStream({ start(c) { for (const p of arr) c.enqueue(p); c.close(); } });

  /** Calls `ping` until `calls` tool results exist, then answers. */
  function repeatToolStreamModel(calls: number): any {
    return {
      specificationVersion: 'v2', provider: 'mock', modelId: 'mock-repeat-tool', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream only'); },
      doStream: async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        if (done < calls) {
          return { stream: parts([
            { type: 'stream-start', warnings: [] },
            { type: 'tool-call', toolCallId: `call-${done + 1}`, toolName: 'ping', input: JSON.stringify({ n: done + 1 }) },
            { type: 'finish', finishReason: 'tool-calls', usage },
          ]) };
        }
        return { stream: parts([
          { type: 'stream-start', warnings: [] },
          { type: 'text-start', id: 't' }, { type: 'text-delta', id: 't', delta: REPLY }, { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: 'stop', usage },
        ]) };
      },
    };
  }
  const ping = tool({ description: 'ping', inputSchema: z.object({ n: z.number() }), execute: async () => ({ ok: true }) });

  it('a limit breach still REJECTS the typed error, and the chain is never asked to transform it', async () => {
    // TITLE NOTE — this used to claim "the mask runs after the gate", which is true of the code
    // (guardStreamTerminalPromises throws `streamFinishError` before calling `mask`) but is NOT what
    // this test measures. Measured, by mutation: swapping those two lines so the mask runs FIRST
    // leaves this test green, because `outputProcessed` independently refuses a turn carrying a
    // limit sentinel; and removing THAT check leaves it green too, because the gate then throws
    // before the mask is ever reached. Two independent guards, each hiding the other — removing
    // BOTH does turn this red (measured: `expected 1 to be +0`), so the assertion is real, but no
    // single-line ordering claim is observable from behavior and the title no longer makes one.
    // The redundancy is deliberate defence in depth, not a leftover to be cleaned up: the gate
    // protects the CALLER's promises, the `outputProcessed` check protects the chain on the
    // onFinish/memory path, and neither one covers the other's entry point.
    const journal = new InMemoryJournal();
    const counter = { out: 0 };
    const res = await streamDurable({
      runId: 'g1', journal, model: repeatToolStreamModel(2), tools: { ping },
      prompt: 'go', stopWhen: stepCountIs(6), limits: { maxToolCalls: 1 },
      processors: [makeRedactor(counter)],
    });
    await expect(res.text).rejects.toBeInstanceOf(RunLimitExceededError);
    // …on every gated surface the mask also covers, not just the one field.
    await expect(res.response).rejects.toBeInstanceOf(RunLimitExceededError);
    // The breached turn is not a finished output, so the chain is not asked to transform it.
    await drainEventLoop();
    expect(counter.out).toBe(0);
  });

  it('a SUSPENDED stream is left alone — the chain does not run and the caller sees the raw partial', async () => {
    // Parity with runDurableInner, which runs output processors only when `interrupts.length === 0`.
    const journal = new InMemoryJournal();
    const counter = { out: 0 };
    const suspendModel = {
      specificationVersion: 'v2', provider: 'mock', modelId: 'mock-suspend', supportedUrls: {},
      doGenerate: async () => { throw new Error('stream only'); },
      doStream: async () => ({ stream: parts([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'call-c', toolName: 'chargeCard', input: JSON.stringify({ amount: 5000 }) },
        { type: 'finish', finishReason: 'tool-calls', usage },
      ]) }),
    };
    const charged = { n: 0 };
    const tools = { chargeCard: tool({ description: 'charge', inputSchema: z.object({ amount: z.number() }), execute: async () => { charged.n++; return { ok: true }; } }) };
    const guard: Guard = ({ toolName }) => (toolName === 'chargeCard' ? { action: 'require-approval', reason: 'big' } : { action: 'allow' });

    const res = await streamDurable({
      runId: 'g2', journal, model: suspendModel, tools, guard, prompt: 'charge',
      stopWhen: stepCountIs(6), processors: [makeRedactor(counter)],
    });
    for await (const _ of res.fullStream) { /* drain */ }
    const text = await res.text;
    await res.response; // the other masked surface — a pass reachable from it happens here, awaited
    await drainEventLoop();

    expect(charged.n).toBe(0);   // really suspended
    // The turn really reached the caller as a raw partial (asserted separately, so "the chain never
    // ran" cannot be satisfied by the stream having produced nothing at all to run it on).
    expect(typeof text).toBe('string');
    expect((await res.steps).length).toBeGreaterThan(0);
    expect(counter.out).toBe(0); // …so the output chain never ran
  });

  it('a processOutput that THROWS leaves `result.text` resolving with the raw value, stream unbroken', async () => {
    // Pre-existing stream contract: a processOutput throw is reported and swallowed (it cannot
    // retroactively stop a stream that already flushed). Masking must not turn it into a NEW
    // rejection path for a promise that never rejected for this reason.
    const journal = new InMemoryJournal();
    const memory = new BasicMemory(journal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exploding: Processor = { name: 'boom', processOutput: () => { throw new Error('processor bug'); } };

    const res = await streamDurable({
      runId: 'g3', journal, memory, threadId: 'tg3', model: createMockStreamModel(textParts(REPLY)),
      processors: [exploding], prompt: 'soru',
    });
    const seen: string[] = [];
    for await (const c of res.textStream) seen.push(c);

    expect(seen.join('')).toBe(REPLY);             // the stream itself is untouched
    await expect(res.text).resolves.toBe(REPLY);   // raw, not a rejection
    await waitFor(() => warn.mock.calls.length > 0);
    expect(warn.mock.calls.flat().join(' ')).toContain('finalization failed');
    warn.mockRestore();
  });
});

describe('KNOWN RESIDUAL — steps/content stay raw, and why no honest fix exists here', () => {
  it('generate: text/response are masked, steps/content are NOT (pinned, both paths)', async () => {
    const journal = new InMemoryJournal();
    const gen: any = await runDurable({
      runId: 'r1', journal, model: createMockModel(async () => finalTextResult(REPLY)),
      processors: [makeRedactor()], prompt: 'soru',
    });
    expect(raw(gen.text)).toBe(false);
    expect(raw(gen.response?.messages)).toBe(false);
    // Documented residual. If a future change masks these, it must be because the processor contract
    // grew a hook that owns step records — update this expectation deliberately, never by accident.
    expect(raw(gen.steps)).toBe(true);
    expect(raw(gen.content)).toBe(true);

    const str: any = await streamDurable({
      runId: 'r2', journal, model: createMockStreamModel(textParts(REPLY)),
      processors: [makeRedactor()], prompt: 'soru',
    });
    for await (const _ of str.textStream) { /* drain */ }
    expect(raw(await str.text)).toBe(false);
    expect(raw((await str.response)?.messages)).toBe(false);
    expect(raw(await str.steps)).toBe(true);
    expect(raw(await str.content)).toBe(true);
  });

  it('ARITY — a legal processor returns fewer messages than the turn produced, so no per-step redistribution exists', async () => {
    // This is the measurement behind the decision, not a rhetorical point. `producedMessages` is a
    // flat concatenation of `steps[i].response.messages`; putting a processed list BACK requires the
    // arity to be preserved. A summariser — as legal a processOutput as a redactor, and the shape
    // tokenLimiter/summarisers actually take — collapses the turn into one message. Index-based
    // redistribution is undefined for it, and a fix that only worked when the counts happened to
    // match would mask a redactor's output while silently leaving a summariser's steps raw.
    const journal = new InMemoryJournal();
    let producedIn = -1;
    let producedOut = -1;
    const summarise: Processor = {
      name: 'summarise',
      processOutput: (o) => {
        producedIn = o.messages.length;
        const out = { ...o, text: 'ozet', messages: [{ role: 'assistant' as const, content: 'ozet' }] };
        producedOut = out.messages.length;
        return out;
      },
    };
    // Two model steps → the turn produces more than one message.
    let step = 0;
    const model = createMockModel(async () => {
      step++;
      return step === 1
        ? { content: [{ type: 'tool-call', toolCallId: 'c1', toolName: 'ping', input: '{"n":1}' }], finishReason: 'tool-calls', usage, warnings: [] }
        : finalTextResult(REPLY);
    });
    const ping = tool({ description: 'ping', inputSchema: z.object({ n: z.number() }), execute: async () => ({ ok: true }) });

    const gen: any = await runDurable({
      runId: 'r3', journal, model, tools: { ping }, prompt: 'soru', stopWhen: stepCountIs(4),
      processors: [summarise],
    });

    expect(gen.steps.length).toBeGreaterThan(1);
    expect(producedIn).toBeGreaterThan(producedOut); // the counts genuinely disagree
    expect(producedOut).toBe(1);
    expect(gen.text).toBe('ozet');                   // the view the contract covers IS transformed
    // …and there is nowhere to put one message back across two steps, which is the residual.
    expect(gen.steps.length).not.toBe(producedOut);
  });
});
