// Guard decisions must not evaporate into the console — every one lands
// as a queryable journal record. Causality-grade checks: the record exists WITH the verbatim message,
// key-identity DEDUPES replays/re-blocks (no spam), and incidents stay INVISIBLE to the run reader
// (time-travel/replay untouched — advisory telemetry, never load-bearing).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { readIncidents } from '../src/incidents.js';
import { DuplicateSideEffectError, ToolLoopDetectedError } from '../src/limits.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

afterEach(() => vi.restoreAllMocks());

const sawNudge = (prompt: any[]) => JSON.stringify(prompt ?? []).includes('__gnl_reflected');

const makeCharge = (counter: { runs: number }) =>
  tool({
    description: 'side-effect tool (unmarked → H7 default)',
    inputSchema: z.object({ orderId: z.string().optional() }),
    execute: async () => {
      counter.runs++;
      return { charged: counter.runs };
    },
  });

const repeatThenFinish = (n: number) =>
  createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done < n) return toolCallResult('charge', `call-${done + 1}`, {});
    return finalTextResult('Done.');
  });

describe('incident journaling', () => {
  it("default 'warn' duplicate is JOURNALED (not just console) with the verbatim message; replay adds nothing", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    await runDurable({ runId: 'inc-1', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) }, prompt: 'go', stopWhen: stepCountIs(10) });

    const incidents = await readIncidents(journal, 'inc-1');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ source: 'duplicate-guard', action: 'warn', toolName: 'charge', toolCallId: 'call-2' });
    expect(incidents[0].message).toContain('EXECUTE AGAIN'); // the SAME console message, queryable now

    // Replay of the completed run: fast-path short-circuits → incident count is stable.
    await runDurable({ runId: 'inc-1', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) }, prompt: 'go', stopWhen: stepCountIs(10) });
    expect(await readIncidents(journal, 'inc-1')).toHaveLength(1);
  });

  it('a still-blocked call re-evaluated on EVERY resume attempt → key-identity keeps ONE incident (no spam)', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const attempt = () =>
      runDurable({
        runId: 'inc-2', journal, model: repeatThenFinish(99), tools: { charge: makeCharge(counter) },
        prompt: 'go', stopWhen: stepCountIs(10),
        limits: { sideEffectDuplicates: 'block' },
      });
    await expect(attempt()).rejects.toBeInstanceOf(DuplicateSideEffectError);
    await expect(attempt()).rejects.toBeInstanceOf(DuplicateSideEffectError); // resume, still blocked
    await expect(attempt()).rejects.toBeInstanceOf(DuplicateSideEffectError);

    const incidents = await readIncidents(journal, 'inc-2');
    expect(incidents).toHaveLength(1); // three identical decisions → one record (idempotent key)
    expect(incidents[0]).toMatchObject({ source: 'duplicate-guard', action: 'block', toolCallId: 'call-2' });
  });

  it('loop-reflect then ignored-nudge block → TWO distinct incidents telling the full story in order', async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    await expect(
      runDurable({
        runId: 'inc-3', journal, model: repeatThenFinish(99), tools: { charge: makeCharge(counter) },
        prompt: 'go', stopWhen: stepCountIs(20),
        limits: { loopDetection: { maxRepeats: 2, onRepeat: 'reflect' }, sideEffectDuplicates: 'off' },
      }),
    ).rejects.toBeInstanceOf(ToolLoopDetectedError);

    const incidents = await readIncidents(journal, 'inc-3');
    expect(incidents.map((i) => [i.source, i.action, i.toolCallId])).toEqual([
      ['loop-detection', 'reflect', 'call-3'], // the nudge
      ['loop-detection', 'block', 'call-4'], // the ignored-nudge stop
    ]);
    expect(incidents[1].message).toContain('reconsider nudge');
  });

  it("duplicate 'suspend' incident carries the approval-facing reason", async () => {
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    const res = await runDurable({
      runId: 'inc-4', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) },
      prompt: 'go', stopWhen: stepCountIs(10),
      limits: { sideEffectDuplicates: 'suspend' },
    });
    expect(res.interrupts).toHaveLength(1);
    const incidents = await readIncidents(journal, 'inc-4');
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ source: 'duplicate-guard', action: 'suspend' });
    expect(incidents[0].message).toContain('A human must approve');
  });

  it('incidents are INVISIBLE to the run reader — time-travel/replay surface is untouched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const journal = new InMemoryJournal();
    const counter = { runs: 0 };
    await runDurable({ runId: 'inc-5', journal, model: repeatThenFinish(2), tools: { charge: makeCharge(counter) }, prompt: 'go', stopWhen: stepCountIs(10) });

    expect(await readIncidents(journal, 'inc-5')).toHaveLength(1); // it IS there…
    const entries = await journal.readRun('inc-5');
    expect(entries.every((e) => e.kind === 'input' || e.kind === 'model' || e.kind === 'tool')).toBe(true); // …but not HERE
  });
});
