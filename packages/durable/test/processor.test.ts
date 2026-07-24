// 8.7 — Processor pipeline behavior (durability-infused).
// input processor transformation is reflected in the journal + does NOT rerun on resume · non-det output
// processor is journaled via ctx.step (same on resume, invisible to the :proc: reader) · output is SKIPPED when suspended.
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { createProcessorCtx, recordProcessorReport, readProcessorReports } from '../src/processor.js';
import type { Processor } from '../src/processor.js';
import { countToolResults, toolCallResult, finalTextResult, createMockModel } from './mock.js';

describe('8.7 processor pipeline', () => {
  it('input processor: transformation is reflected in the journal + does not rerun on resume', async () => {
    const journal = new InMemoryJournal();
    let inputCalls = 0;
    const upper: Processor = {
      name: 'upper',
      processInput: (i) => {
        inputCalls++;
        return { ...i, prompt: typeof i.prompt === 'string' ? i.prompt.toUpperCase() : i.prompt };
      },
    };
    const model = () => createMockModel(async () => finalTextResult('ok'));

    await runDurable({ runId: 'r', journal, model: model(), processors: [upper], stopWhen: stepCountIs(4), prompt: 'hello' });
    expect(inputCalls).toBe(1);
    expect((await journal.get<any>('r:input')).prompt).toBe('HELLO'); // transformed input was journaled

    // Resume: same runId → input is already in the journal → processor does NOT rerun.
    await runDurable({ runId: 'r', journal, model: model(), processors: [upper], stopWhen: stepCountIs(4), prompt: 'hello' });
    expect(inputCalls).toBe(1);
  });

  it('non-det output processor: journaled via ctx.step; same on resume; invisible to the :proc: reader', async () => {
    const journal = new InMemoryJournal();
    let computeCalls = 0;
    const tagger: Processor = {
      name: 'tagger',
      processOutput: async (o, ctx) => {
        const tag = await ctx.step('tag', () => `tag-${++computeCalls}`);
        return { ...o, text: `${o.text} [${tag}]` };
      },
    };
    const model = () => createMockModel(async () => finalTextResult('answer'));

    const r1 = await runDurable({ runId: 'r', journal, model: model(), processors: [tagger], stopWhen: stepCountIs(4), prompt: 'x' });
    expect(r1.text).toBe('answer [tag-1]');
    expect(computeCalls).toBe(1);
    const entries = await journal.readRun('r');
    expect(entries.some((e) => e.key.includes(':proc:'))).toBe(false); // not visible in the :proc: reader

    const r2 = await runDurable({ runId: 'r', journal, model: model(), processors: [tagger], stopWhen: stepCountIs(4), prompt: 'x' });
    expect(r2.text).toBe('answer [tag-1]'); // SAME tag on resume
    expect(computeCalls).toBe(1); // ctx.step journaled → compute did not rerun
  });

  it('suspended run: output processor is SKIPPED (run is not final)', async () => {
    const journal = new InMemoryJournal();
    let outCalls = 0;
    const proc: Processor = { name: 'p', processOutput: (o) => ((outCalls++), o) };
    const model = () =>
      createMockModel(async ({ prompt }: any) =>
        countToolResults(prompt) === 0 ? toolCallResult('danger', 'call-d', {}) : finalTextResult('done'),
      );
    const tools = { danger: { execute: async () => 'ran' } };
    const guard = () => ({ action: 'require-approval' as const });

    const res = await runDurable({
      runId: 'r', journal, model: model(), tools, guard, processors: [proc], stopWhen: stepCountIs(6), prompt: 'x',
    });
    expect(res.interrupts.length).toBe(1);
    expect(outCalls).toBe(0); // suspended → output processor did not run
  });
});

describe('recordProcessorReport / readProcessorReports (audit reports — additive)', () => {
  it('the record is written to the journal + read via readProcessorReports; does NOT LEAK to the :model:/:tool: reader (readRun)', async () => {
    const journal = new InMemoryJournal();
    const ctx = createProcessorCtx(journal, 'r1');
    await recordProcessorReport(ctx, 'pii-redactor', 'input', { redactedCount: 2, types: ['email'] });

    const reports = await readProcessorReports(journal, 'r1');
    expect(reports).toEqual([{ name: 'pii-redactor', phase: 'input', findings: { redactedCount: 2, types: ['email'] }, ts: expect.any(Number) }]);

    // invisible to parseJournalKey (same principle as :proc: / :input / :cfg:model) → readRun stays empty.
    const entries = await journal.readRun('r1');
    expect(entries).toEqual([]);
  });

  it('overwrite-safe: a second call for the same name+phase does NOT OVERWRITE the previous record (written only once)', async () => {
    const journal = new InMemoryJournal();
    const ctx = createProcessorCtx(journal, 'r2');
    await recordProcessorReport(ctx, 'moderation', 'output', { hit: 'first' });
    await recordProcessorReport(ctx, 'moderation', 'output', { hit: 'second' }); // different findings — must be IGNORED

    const reports = await readProcessorReports(journal, 'r2');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.findings).toEqual({ hit: 'first' });
  });

  it('returns an empty array for a journal that does not support listKeys (does not throw)', async () => {
    const bare = { get: async () => undefined, put: async () => {} } as any;
    expect(await readProcessorReports(bare, 'r3')).toEqual([]);
  });

  it('best-effort: recordProcessorReport SILENTLY swallows a missing/broken ctx.journal (does not throw)', async () => {
    const brokenCtx = { runId: 'r4', journal: {} as any, step: async (_n: string, c: any) => c() };
    await expect(recordProcessorReport(brokenCtx as any, 'x', 'input', { a: 1 })).resolves.toBeUndefined();
  });

  it('multiple processors/phases are stored under independent keys (combined name+phase key)', async () => {
    const journal = new InMemoryJournal();
    const ctx = createProcessorCtx(journal, 'r5');
    await recordProcessorReport(ctx, 'pii-redactor', 'input', { redactedCount: 1 });
    await recordProcessorReport(ctx, 'pii-redactor', 'output', { redactedCount: 3 });
    await recordProcessorReport(ctx, 'prompt-injection', 'input', { matched: ['ignore previous'] });

    const reports = await readProcessorReports(journal, 'r5');
    expect(reports.map((r) => `${r.name}:${r.phase}`).sort()).toEqual([
      'pii-redactor:input', 'pii-redactor:output', 'prompt-injection:input',
    ]);
  });

  it('end-to-end: redaction → report in a real pipeline; RERUNNING a COMPLETED run (resume) does NOT DOUBLE-WRITE the report', async () => {
    const journal = new InMemoryJournal();
    const redactor: Processor = {
      name: 'pii-redactor',
      processInput: (input, ctx) => {
        const redacted = typeof input.prompt === 'string' ? input.prompt.replace('a@b.com', '[REDACTED]') : input.prompt;
        if (redacted !== input.prompt) void recordProcessorReport(ctx, 'pii-redactor', 'input', { redactedCount: 1, types: ['email'] });
        return { ...input, prompt: redacted };
      },
    };
    const model = () => createMockModel(async () => finalTextResult('ok'));

    await runDurable({ runId: 'rr', journal, model: model(), processors: [redactor], stopWhen: stepCountIs(4), prompt: 'mail a@b.com' });
    let reports = await readProcessorReports(journal, 'rr');
    expect(reports).toEqual([{ name: 'pii-redactor', phase: 'input', findings: { redactedCount: 1, types: ['email'] }, ts: expect.any(Number) }]);
    const firstTs = reports[0]!.ts;

    // Resume: the input processor does NOT RERUN (applyInputProcessors already skips the journaled input) →
    // but as a safety net for re-invoking a COMPLETED run (same runId) for processOutput/any future replay:
    // the report is NOT REWRITTEN (overwrite-safe), ts DOES NOT CHANGE.
    await runDurable({ runId: 'rr', journal, model: model(), processors: [redactor], stopWhen: stepCountIs(4), prompt: 'mail a@b.com' });
    reports = await readProcessorReports(journal, 'rr');
    expect(reports).toHaveLength(1);
    expect(reports[0]!.ts).toBe(firstTs);
  });
});
