// A `threadId` handed to a run with no memory attached: what happens is nothing, and until now
// nothing was also what was SAID.
//
// The drop is structural — every memory branch in run.ts is guarded by `memory && threadId`, so a
// caller who passes only the second half falls through all of them. That is the correct behaviour and
// the wrong silence: the id is accepted, echoed back in the run summary, used to group runs in Studio,
// and carries no conversation. A developer reads all of that as "threads work" and finds out otherwise
// when a second turn does not remember the first.
//
// Once per process, deliberately. This is a wiring mistake, so the first run says it and the next ten
// thousand do not — the alternative is a line per request, which is how a warning becomes log noise
// people filter out.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { InMemoryJournal } from '../src/journal.js';
import { InMemoryStorage } from '../src/in-memory-storage.js';
import { createMockModel, finalTextResult } from './mock.js';
import type { Memory } from '../src/memory.js';

afterEach(() => vi.restoreAllMocks());

/**
 * A fresh module graph per test, because the "once" is module state.
 *
 * Exporting a reset hook from run.ts would have been the smaller diff and the worse one: a test-only
 * export is a public API nobody asked for, and it invites production code to clear the flag too.
 */
async function freshRun(): Promise<typeof import('../src/run.js')> {
  vi.resetModules();
  return import('../src/run.js');
}

/** The smallest Memory that satisfies the load path — it holds nothing and that is fine here. */
function emptyMemory(): Memory {
  return {
    getMessages: async () => [],
    append: async () => {},
  } as unknown as Memory;
}

const model = () => createMockModel(async () => finalTextResult('ok'));

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

const threadWarnings = (): string[] =>
  warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('threadId'));

describe('a threadId with no memory behind it', () => {
  it('warns ONCE per process, no matter how many runs repeat the mistake', async () => {
    const { runDurable } = await freshRun();
    const journal = new InMemoryJournal();
    for (const runId of ['ti-1', 'ti-2', 'ti-3']) {
      await runDurable({ runId, journal, model: model(), prompt: 'hi', threadId: 'thread-a' });
    }
    const said = threadWarnings();
    expect(said).toHaveLength(1);
  });

  it('the message names what happened, what it costs, and the two ways out', async () => {
    const { runDurable } = await freshRun();
    await runDurable({ runId: 'ti-4', journal: new InMemoryJournal(), model: model(), prompt: 'hi', threadId: 'thread-b' });
    const [msg] = threadWarnings();
    expect(msg).toBeDefined();
    // error: what already happened, in the past tense — the id was taken and dropped.
    expect(msg).toMatch(/thread-b/);
    // note: the cost, said concretely rather than as "may not work as expected".
    expect(msg).toMatch(/remember|history/i);
    // help: both remedies, the second being the way to silence this on purpose.
    expect(msg).toContain('gnl add memory');
    expect(msg).toContain('memory: false');
  });

  it('says nothing when memory IS attached', async () => {
    const { runDurable } = await freshRun();
    await runDurable({
      runId: 'ti-5', journal: new InMemoryJournal(), model: model(), prompt: 'hi',
      threadId: 'thread-c', memory: emptyMemory(),
    });
    expect(threadWarnings()).toHaveLength(0);
  });

  it('says nothing when the caller declared `memory: false` — the deliberate-silence gate', async () => {
    // The difference between "I forgot" and "I know, and I meant it". Without a way to say the second,
    // a correct project has a permanent warning it can only silence by filtering the console.
    const { runDurable } = await freshRun();
    await runDurable({
      runId: 'ti-6', journal: new InMemoryJournal(), model: model(), prompt: 'hi',
      threadId: 'thread-d', memory: false,
    });
    expect(threadWarnings()).toHaveLength(0);
  });

  it('says nothing when no threadId was passed at all — there is no mistake to report', async () => {
    const { runDurable } = await freshRun();
    await runDurable({ runId: 'ti-7', journal: new InMemoryJournal(), model: model(), prompt: 'hi' });
    expect(threadWarnings()).toHaveLength(0);
  });
});

describe('the streaming half behaves identically', () => {
  it('warns once, and honours `memory: false`', async () => {
    const { streamDurable } = await freshRun();
    const storage = new InMemoryStorage();
    const s1 = await streamDurable({ runId: 'tis-1', journal: storage.runs as never, model: model(), prompt: 'hi', threadId: 'thread-e' });
    for await (const _ of s1.textStream) { /* drain */ }
    expect(threadWarnings()).toHaveLength(1);

    const s2 = await streamDurable({ runId: 'tis-2', journal: storage.runs as never, model: model(), prompt: 'hi', threadId: 'thread-f', memory: false });
    for await (const _ of s2.textStream) { /* drain */ }
    expect(threadWarnings()).toHaveLength(1); // still the one from the run above
  });
});
