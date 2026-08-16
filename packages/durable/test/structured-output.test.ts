// P2-structured (AUDIT-R2 Dalga-2): schema-validated structured output THROUGH the durable
// substrate. The load-bearing claim: `output` (AI SDK `Output.object`; `experimental_output` before it graduated in v7) flows into
// generateText via runDurable's `...rest` pass-through, and because the PARSING happens ABOVE the
// journaled model step (withDurableModel journals the raw provider result; generateText derives the
// object from it), replay is deterministic FOR FREE — a resumed/replayed run yields the SAME parsed
// object WITHOUT calling the model again. These tests turn that from an assumption into a contract.
import { describe, it, expect } from 'vitest';
import { Output } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createMockModel, finalTextResult } from './mock.js';

describe('structured output through runDurable (output pass-through contract)', () => {
  const schema = z.object({ city: z.string(), population: z.number() });

  it('parses the schema-validated object AND replays it deterministically without re-calling the model', async () => {
    const journal = new InMemoryJournal();
    let modelCalls = 0;
    const model = createMockModel(async () => {
      modelCalls++;
      return finalTextResult(JSON.stringify({ city: 'Ankara', population: 5_800_000 }));
    });

    const r1: any = await runDurable({
      runId: 'r-so1', journal, model, prompt: 'city?',
      output: Output.object({ schema }),
    } as any);
    expect(r1.output).toEqual({ city: 'Ankara', population: 5_800_000 });
    expect(modelCalls).toBe(1);

    // Replay: same runId → journaled model step replays; the object is re-derived identically, model NOT called.
    const r2: any = await runDurable({
      runId: 'r-so1', journal, model, prompt: 'city?',
      output: Output.object({ schema }),
    } as any);
    expect(r2.output).toEqual({ city: 'Ankara', population: 5_800_000 });
    expect(modelCalls).toBe(1); // exactly-once held
  });

  it('schema violation REJECTS the run at generateText time (fail-loud, never a silently-wrong object)', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async () => finalTextResult(JSON.stringify({ city: 'X' }))); // population missing
    await expect(
      runDurable({
        runId: 'r-so2', journal, model, prompt: 'city?',
        output: Output.object({ schema }),
      } as any),
    ).rejects.toThrow(/did not match schema/);
    // The raw model step IS journaled (write happened below the parse) — a corrected schema or a
    // fork can still consume the recorded output; the journal never hides what the model produced.
    const entries = await journal.readRun('r-so2');
    expect(entries.some((e) => e.kind === 'model')).toBe(true);
  });
});
