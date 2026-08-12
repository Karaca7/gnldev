// A model step journaled by the NON-streaming
// path (wrapGenerate: a raw doGenerate result, NO `.parts`) replayed through streamDurable feeds
// `hit.parts === undefined` to simulateReadableStream → a broken/empty replay stream, with no signal. And
// vice-versa (a `{parts,rest}` stream record replayed through generate). The guard now THROWS a clear
// error naming the mismatch instead of silently diverging.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable, streamDurable } from '../src/run.js';
import { createMockModel, createMockStreamAgent, finalTextResult } from './mock.js';

const MISMATCH = /replay entry-point mismatch/i;

/** Drain a streamDurable result's fullStream and return the first surfaced stream error (if any). */
async function firstStreamError(r: any): Promise<Error | undefined> {
  for await (const part of r.fullStream) {
    if (part?.type === 'error') return part.error as Error;
  }
  return undefined;
}

describe('E2 — generate<->stream entry-point mismatch on the same runId', () => {
  it('a run journaled via runDurable, resumed via streamDurable, surfaces a CLEAR error (not a silent empty stream)', async () => {
    const journal = new InMemoryJournal();
    // Run 1: non-streaming entry point → journals a generate model record (no `.parts`) at r:model:0.
    const r1 = await runDurable({
      runId: 'e2-mismatch', journal, model: createMockModel(async () => finalTextResult('hello')),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    expect(r1.text).toContain('hello');

    // Run 2: SAME runId through the STREAMING entry point → replay hits the generate record.
    const r2 = await streamDurable({
      runId: 'e2-mismatch', journal, model: createMockStreamAgent(),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    // The mismatch surfaces as an explicit stream error part (previously: a cryptic "reading 'length'"
    // on an empty/broken stream). The text promise rejects rather than resolving to silent output.
    const err = await firstStreamError(r2);
    expect(String(err?.message)).toMatch(MISMATCH);
    await expect(r2.text).rejects.toThrow();
  });

  it('the mismatch error names the entry points so the operator knows which path to resume through', async () => {
    const journal = new InMemoryJournal();
    await runDurable({
      runId: 'e2-named', journal, model: createMockModel(async () => finalTextResult('hi')),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    const r2 = await streamDurable({
      runId: 'e2-named', journal, model: createMockStreamAgent(),
      prompt: 'go', stopWhen: stepCountIs(3),
    });
    const err = await firstStreamError(r2);
    expect(String(err?.message)).toMatch(/streamDurable|streaming/i);
    expect(String(err?.message)).toMatch(/runDurable|non-streaming/i);
  });
});
