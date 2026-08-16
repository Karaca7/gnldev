// The tripwire for the next AI SDK major.
//
// Four separate behaviour breaks crossed the v5→v7 boundary without a single type error, because
// journal records travel through `any`: nested usage silently disabled every spend ceiling, an
// object finishReason made `=== 'error'` permanently false (a failed run recorded as SUCCEEDED), a
// widened `system` turned prompt concatenation into "[object Object]", and system messages inside
// replayed history started throwing. Types cannot see any of it. Only an assertion on the
// SERIALISED RECORD can.
//
// So this file asserts the shape of what actually lands in the journal, against whatever `ai` is
// installed. When v8 changes a payload, this fails on day one with a message naming the installed
// version — instead of a spend ceiling going quiet in production six weeks later.
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { withDurableModel } from '../src/durable-model.js';
import { upgradeFormat, stampFormat, JOURNAL_FORMAT_VERSION } from '../src/format.js';
import { flattenUsage, finishReasonText } from '../src/sdk-compat.js';
import { createMockModel, finalTextResult } from './mock.js';

const installedAiVersion = (() => {
  try {
    return createRequire(import.meta.url)('ai/package.json').version as string;
  } catch {
    return 'unknown';
  }
})();

/** Fails with the installed version in the message — the first thing you want when this goes red. */
const because = (what: string) => `${what} (installed ai@${installedAiVersion})`;

describe(`AI SDK record contract — ai@${installedAiVersion}`, () => {
  it('a journaled model step still carries usage and a finish reason this build can read', async () => {
    const journal = new InMemoryJournal();
    const model = createMockModel(async () => finalTextResult('hello'));
    const m = withDurableModel(model, { journal, runId: 'contract-1' });
    await (m as any).doGenerate({ prompt: [] });

    const rec: any = await journal.get(runKeys.model('contract-1', 0));
    expect(rec, because('no model record was journaled at all')).toBeDefined();

    // Not `rec.usage.inputTokens === 10`: the POINT is that whatever shape the SDK produced, the
    // compat layer still yields numbers. If a future major nests it one level deeper, this is the
    // line that goes red.
    const usage = flattenUsage(rec.usage);
    expect(typeof usage.inputTokens, because('input tokens are not a number after flattening')).toBe('number');
    expect(typeof usage.outputTokens, because('output tokens are not a number after flattening')).toBe('number');
    expect(usage.totalTokens, because('total tokens came out as zero — every spend ceiling depends on this')).toBeGreaterThan(0);

    expect(typeof finishReasonText(rec.finishReason), because('finish reason does not reduce to a string')).toBe('string');
  });

  it('the finish reason reduces to the exact word the engine compares against', () => {
    // run.ts decides success vs failure with `finishReasonText(...) === 'error'`. If a major ever
    // renames the unified vocabulary, the comparison stops matching and failed runs are journaled
    // as successes — silently. Pin the words the engine actually branches on.
    expect(finishReasonText('error')).toBe('error');
    expect(finishReasonText({ unified: 'error', raw: 'provider_error' })).toBe('error');
    expect(finishReasonText('stop')).toBe('stop');
    expect(finishReasonText({ unified: 'stop', raw: 'end_turn' })).toBe('stop');
  });

  it('cached input tokens are found under whichever name the SDK uses', () => {
    // The cache discount read `usage.cachedTokens` for gnl's whole history — a field no AI SDK
    // version has ever had. It silently applied zero discount on every provider. Both real spellings
    // are pinned here so the next rename fails loudly instead of quietly costing money.
    expect(flattenUsage({ inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 }).cachedTokens).toBe(40);
    expect(flattenUsage({ inputTokens: { total: 100, cacheRead: 40 }, outputTokens: { total: 10 } }).cachedTokens).toBe(40);
  });

  it('a REAL AI SDK v5 record still replays under the current SDK', () => {
    // The fixture is the multi-version promise. A peer range claims compatibility; this proves it.
    // Captured from a journal written by gnl running ai@5.0.204 — flat usage, string finishReason.
    const v5ModelRecord = {
      content: [{ type: 'text', text: 'APPROVED c-1001: $400.00 reimbursed.' }],
      finishReason: 'stop',
      usage: { inputTokens: 120, outputTokens: 40, totalTokens: 160, cachedInputTokens: 25 },
      warnings: [],
    };

    // Unstamped, exactly as gnl wrote it before format v2 existed.
    const replayed: any = upgradeFormat(v5ModelRecord, 'claim:c-1001:model:0');

    expect(replayed.content, because('content must survive the upgrade untouched')).toEqual(v5ModelRecord.content);
    const usage = flattenUsage(replayed.usage);
    expect(usage.inputTokens).toBe(120);
    expect(usage.outputTokens).toBe(40);
    expect(usage.cachedTokens, because('the cached count was dropped during the upgrade')).toBe(25);
    expect(finishReasonText(replayed.finishReason)).toBe('stop');
    expect('_v' in replayed, because('the storage stamp leaked into the replayed object')).toBe(false);
  });

  it('a record written today round-trips through stamp → upgrade unchanged', () => {
    const written = stampFormat({ content: [{ type: 'text', text: 'hi' }], finishReason: { unified: 'stop', raw: 'stop' } });
    expect((written as any)._v).toBe(JOURNAL_FORMAT_VERSION);
    expect(upgradeFormat(written, 'r:model:0')).toEqual({
      content: [{ type: 'text', text: 'hi' }],
      finishReason: { unified: 'stop', raw: 'stop' },
    });
  });
});
