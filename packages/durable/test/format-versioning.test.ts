// H13 — journal format versioning: defusing the "pending runs die when SDK v6 ships" time bomb.
// Contract: stamp _v when writing; when reading, unstamped=v1, old→upgrader chain, unknown→NOISY error.
import { describe, it, expect, afterEach } from 'vitest';
import {
  InMemoryJournal, runKeys, durableTool,
  JOURNAL_FORMAT_VERSION, JournalFormatError, registerFormatUpgrade, stampFormat, upgradeFormat, isVersionedKey,
} from '../src/index.js';
import { ctxGet } from '../src/journal.js';

const disposers: Array<() => void> = [];
afterEach(() => { while (disposers.length) disposers.pop()!(); });

describe('H13 — format units', () => {
  it('isVersionedKey: only input/model/tool; lock/proc/counter are EXCLUDED (putIfMatch byte-equality is preserved)', () => {
    expect(isVersionedKey('r1:input')).toBe(true);
    expect(isVersionedKey('r1:model:0')).toBe(true);
    expect(isVersionedKey('r1:tool:call-9')).toBe(true);
    expect(isVersionedKey('agent:c1:model:3')).toBe(true); // nested runId (contains ':')
    expect(isVersionedKey('r1:lock')).toBe(false);
    expect(isVersionedKey('r1:proc:__gnl_model_claim:0')).toBe(false);
    expect(isVersionedKey('__gnl_usage__:t1')).toBe(false);
  });

  it('an unstamped record = v1 (ALL data written up to today): read as-is', () => {
    const eski = { content: [{ type: 'text', text: 'hello' }], usage: { totalTokens: 5 } };
    expect(upgradeFormat(eski, 'r:model:0')).toEqual(eski);
  });

  it('current stamp: _v is stripped, content stays as-is (the stamp does not leak into the user object)', () => {
    const record = stampFormat({ status: 'succeeded', output: 42 });
    expect((record as any)._v).toBe(JOURNAL_FORMAT_VERSION);
    expect(upgradeFormat(record, 'r:tool:c1')).toEqual({ status: 'succeeded', output: 42 });
  });

  it('a FUTURE-version record (_v high): not silent corruption — JournalFormatError with key+version', () => {
    expect(() => upgradeFormat({ _v: 99, x: 1 }, 'r:model:3')).toThrow(JournalFormatError);
    expect(() => upgradeFormat({ _v: 99, x: 1 }, 'r:model:3')).toThrow(/r:model:3.*v99/s);
  });

  it('an old version + a registered upgrader CHAIN: v1→v2→v3 applied in order (proof of an SDK-major transition)', () => {
    // Scenario: v2 turned 'content' into 'blocks'; v3 wrapped 'blocks' in {items}.
    disposers.push(registerFormatUpgrade(1, (r) => ({ blocks: r.content, _v: 2 })));
    disposers.push(registerFormatUpgrade(2, (r) => ({ blocks: { items: r.blocks }, _v: 3 })));
    const v1kaydi = { content: ['a', 'b'] }; // unstamped = v1
    expect(upgradeFormat(v1kaydi, 'r:model:0', 3)).toEqual({ blocks: { items: ['a', 'b'] } });
  });

  it('a missing link: v1 record, target v3, only 2→3 is registered → the missing converter is REPORTED', () => {
    disposers.push(registerFormatUpgrade(2, (r) => ({ ...r, _v: 3 })));
    expect(() => upgradeFormat({ x: 1 }, 'r:model:0', 3)).toThrow(/no v1→v2 upgrader is registered/);
  });

  it('null/primitive/array values pass through untouched', () => {
    expect(upgradeFormat(undefined, 'r:model:0')).toBeUndefined();
    expect(upgradeFormat(7 as any, 'r:model:0')).toBe(7);
    expect(upgradeFormat(['a'] as any, 'r:model:0')).toEqual(['a']);
  });
});

describe('H13 — end-to-end: writes are stamped, reads are transparent', () => {
  it('durableTool stamps the record it writes; a replay read returns unstamped content', async () => {
    const journal = new InMemoryJournal();
    const dt = durableTool(
      { idempotent: true, execute: async () => ({ sonuc: 'ok' }) },
      { journal, runId: 'fv1' },
      'search',
    );
    await dt.execute!({ q: 'x' }, { toolCallId: 'c1' });

    // RAW record (journal.get returns raw from the adapter — the format gate lives in ctxGet/durable-tool):
    const ham = await journal.get<any>(runKeys.tool('fv1', 'c1'));
    expect(ham._v).toBe(JOURNAL_FORMAT_VERSION); // 🔑 written to disk with a stamp

    // Replay: the second call returns from the journal, the stamp does NOT LEAK:
    const out = await dt.execute!({ q: 'x' }, { toolCallId: 'c1' });
    expect(out).toEqual({ sonuc: 'ok' });
  });

  it('an OLD (unstamped) succeeded tool record replays identically under new code — backward compatibility', async () => {
    const journal = new InMemoryJournal();
    // A raw record written by yesterday's GNL (no stamp):
    await journal.put(runKeys.tool('fv2', 'c1'), { status: 'succeeded', output: { charged: 20 } });
    let calls = 0;
    const dt = durableTool(
      { execute: async () => { calls++; return { charged: 99 }; } },
      { journal, runId: 'fv2' },
      'chargeCard',
    );
    expect(await dt.execute!({ amount: 20 }, { toolCallId: 'c1' })).toEqual({ charged: 20 });
    expect(calls).toBe(0); // replay — no re-execution
  });

  it('a FUTURE-version tool record: replay does not silently break, JournalFormatError is thrown', async () => {
    const journal = new InMemoryJournal();
    await journal.put(runKeys.tool('fv3', 'c1'), { _v: 99, status: 'succeeded', output: 1 });
    const dt = durableTool(
      { execute: async () => 2 },
      { journal, runId: 'fv3' },
      'x',
    );
    await expect(dt.execute!({}, { toolCallId: 'c1' })).rejects.toThrow(JournalFormatError);
  });

  it('ctxGet format gate: a model key is upgraded, a proc/lock key is UNTOUCHED', async () => {
    const journal = new InMemoryJournal();
    const ctx = { journal, runId: 'fv4' } as any;
    // A fake-old model record + no v1→current converter is needed (v1 = current); the stamp must be stripped:
    await journal.put(runKeys.model('fv4', 0), { _v: 1, content: ['a'] });
    expect(await ctxGet(ctx, runKeys.model('fv4', 0))).toEqual({ content: ['a'] });
    // proc key: even if it has _v, it does NOT ENTER the format gate (returned as-is):
    await journal.put('fv4:proc:__x', { _v: 99, raw: true });
    expect(await ctxGet(ctx, 'fv4:proc:__x')).toEqual({ _v: 99, raw: true });
  });
});
