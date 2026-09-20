// FAZ-6 — the semantic duplicate-candidate gate. What is pinned here:
// 1) double opt-in, and a THROW on every config contradiction (action/scope/embedModelId/keys[]/noApprovals)
// 2) end to end: success → a semantic record; a paraphrase-like repeat → suspend (carrying firstToolCallId);
//    approval → runs and births a "different work" tombstone; that pair is NEVER asked about again
// 3) score alone NEVER suspends (identity mismatch → telemetry only, output byte-identical)
// 4) negation gates: cross-tool (the toolName filter) and intra-tool (discriminatorFields)
// 5) the magnitude gate: identity equal + amount different → a suspend that says "amounts differ"
// 6) fail-open: a broken embedder still writes the record (without a vector), recall passes quietly,
//    work is never blocked; three consecutive failures raise ONE outage incident
// 7) stamp discipline: a record written under a different embedModelId is never compared
// 8) lifecycle: purgeThread sweeps the sem + semtomb families; another thread is never a candidate
// 9) a replay never pays for the embedding again; without a threadId the layer loudly stands down
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { purgeThread } from '../src/retention.js';
import { durableTools } from '../src/durable-tool.js';
import { readIncidents } from '../src/incidents.js';
import { semKey, semTombKey } from '../src/semantic-dup.js';
import type { SemDupRecord } from '../src/semantic-dup.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

/** Deterministic fake embedder: text → a one-hot-ish vector. Identical text scores 1.0, different
 *  text 0.0 — so a test builds similarity by giving both calls the SAME canonical sentence (a
 *  constant describe() is how the "similar but identity-less" case is staged). */
function fakeEmbed(counter?: { n: number }) {
  return async (texts: string[]): Promise<number[][]> => {
    if (counter) counter.n += texts.length;
    return texts.map((t) => {
      let h = 0;
      for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) >>> 0;
      const vec = new Array(32).fill(0);
      vec[h % 32] = 1;
      vec[(h >> 5) % 32] += 0.5;
      return vec;
    });
  };
}

const semLimits = (embed: (t: string[]) => Promise<number[][]>, modelId: string, extra: Record<string, unknown> = {}) => ({
  sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, semantic: { embed, embedModelId: modelId, ...extra } },
});

const model = (toolName: string, callId: string, args: unknown) => () =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult(toolName, callId, args) : finalTextResult('done'));

const base = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown>) => ({
  runId, journal, stopWhen: stepCountIs(6), prompt: 'x', ...extra,
});

describe('FAZ-6 config gates', () => {
  const dummyEmbed = fakeEmbed();
  it("semantic + action!=='suspend' → THROWS before the run starts", async () => {
    const limits = { sideEffectDuplicates: { action: 'warn' as const, scope: 'thread' as const, semantic: { embed: dummyEmbed, embedModelId: 'm' } } };
    const tools = { t: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    await expect(
      runDurable(base(new InMemoryJournal(), 'c1', { model: model('t', 'x', {})(), tools, threadId: 'th', limits }) as any),
    ).rejects.toThrow(/action: 'suspend'/);
  });
  it('missing embedModelId → THROW; empty keys → THROW; noApprovals → THROW', () => {
    const journal = new InMemoryJournal();
    const mk = (limits: any, tools: any, noApprovals = false) => () =>
      durableTools(tools, { journal, runId: 'c2', limits, ...(noApprovals ? { noApprovals: true } : {}) } as any);
    const okTools = { t: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => 1 } };
    expect(mk({ sideEffectDuplicates: { action: 'suspend', scope: 'thread', semantic: { embed: dummyEmbed } } }, okTools)).toThrow(/embedModelId/);
    expect(mk(semLimits(dummyEmbed, 'm'), { t: { sideEffect: true, semanticIdentity: { keys: [] }, execute: async () => 1 } })).toThrow(/EMPTY keys/);
    expect(mk(semLimits(dummyEmbed, 'm'), okTools, true)).toThrow(/no approvals channel/i);
  });
});

describe('FAZ-6 end-to-end flow', () => {
  it('success → record; a similar repeat → suspend; approval → runs + tombstone; that pair is never asked again', async () => {
    const journal = new InMemoryJournal();
    const embeds = { n: 0 };
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(embeds), 'e2e-model');
    const tools = {
      createProduct: {
        sideEffect: true,
        semanticIdentity: { keys: ['sku'] },
        execute: async ({ sku }: any) => { counter.n++; return { created: sku }; },
      },
    };
    // r1: "create product ABC"
    await runDurable(base(journal, 'r1', { model: model('createProduct', 'call-1', { sku: 'ABC', note: 'first' })(), tools, threadId: 'th-A', limits }) as any);
    expect(counter.n).toBe(1);
    const semKeys = await journal.listKeys('xthr:th-A:sem-');
    expect(semKeys).toHaveLength(1);
    const rec = await journal.get<SemDupRecord>(semKeys[0]!);
    expect(rec).toMatchObject({ v: 1, toolName: 'createProduct', embedModelId: 'e2e-model', identity: { sku: 'abc' }, firstToolCallId: 'call-1' });
    expect(rec!.vecB64).toBeTruthy();
    expect(rec!.canonical).toBe('createProduct: abc');
    expect(rec!.canonical).not.toContain('first'); // beyan edilmeyen alan embedder'a SIZMAZ

    // r2: next day, the same job in different words (different hash, same identity)
    const r2model = model('createProduct', 'call-2', { sku: ' abc ', note: 'forgot, again' }); // proof of trim + case-fold normalization
    await runDurable(base(journal, 'r2', { model: r2model(), tools, threadId: 'th-A', limits }) as any);
    expect(counter.n).toBe(1); // NOT fired — a question was asked instead
    const susRec = await journal.get<any>('r2:tool:call-2');
    expect(susRec.status).toBe('suspended');
    expect(susRec.output.__gnl_suspend.reason).toContain('call-1'); // ilk sonucun adresi soruda
    expect(susRec.output.__gnl_suspend.reason).toContain('% match');
    const incidents = await readIncidents(journal, 'r2');
    expect(incidents.some((i) => i.source === 'semantic-guard' && i.action === 'suspend')).toBe(true);

    // approval: the human said "do it anyway" → it runs, and a 'different work' tombstone is born
    await runDurable(base(journal, 'r2', { model: r2model(), tools, threadId: 'th-A', limits, approvals: { 'call-2': true } }) as any);
    expect(counter.n).toBe(2);
    const tombs = await journal.listKeys('xthr:th-A:semtomb-');
    expect(tombs).toHaveLength(1);

    // r3: the SAME arguments as r2 → now LAYER 3's exact-hash marker catches it (deterministic
    // beats probabilistic: the semantic gate is never reached, the question belongs to layer 3):
    await runDurable(base(journal, 'r3', { model: model('createProduct', 'call-3', { sku: ' abc ', note: 'forgot, again' })(), tools, threadId: 'th-A', limits }) as any);
    expect(counter.n).toBe(2);
    const r3rec = await journal.get<any>('r3:tool:call-3');
    expect(r3rec.status).toBe('suspended');
    expect(r3rec.output.__gnl_suspend.reason).toContain('identical arguments'); // the exact layer's voice, not the semantic one's

    // another thread is NOT a candidate
    await runDurable(base(journal, 'r4', { model: model('createProduct', 'call-4', { sku: 'ABC', note: 'another conversation' })(), tools, threadId: 'th-B', limits }) as any);
    expect(counter.n).toBe(3);
  });

  it("tombstone: a pair ruled 'different work' is never asked about again, even without an exact marker", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'tomb-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const argsA = { sku: 'T-1', note: 'first' };
    const argsB = { sku: 'T-1', note: 'second' }; // different hash, same identity → normally a suspend candidate
    await runDurable(base(journal, 't1', { model: model('createProduct', 'c1', argsA)(), tools, threadId: 'th-T', limits }) as any);
    // Plant the tombstone by hand, as if a human had already ruled this pair 'different work'
    // (the same key the approval path writes):
    const { argsHash } = await import('../src/hash.js');
    await journal.put(semTombKey('th-T', 'createProduct', argsHash(argsA), argsHash(argsB)), { at: 1 });
    await runDurable(base(journal, 't2', { model: model('createProduct', 'c2', argsB)(), tools, threadId: 'th-T', limits }) as any);
    expect(counter.n).toBe(2); // no question — this pair had already been ruled on
    // A third variant with no tombstone is still asked about (a tombstone covers a PAIR, not a blanket):
    await runDurable(base(journal, 't3', { model: model('createProduct', 'c3', { sku: 'T-1', note: 'third' })(), tools, threadId: 'th-T', limits }) as any);
    expect(counter.n).toBe(2);
    expect((await journal.get<any>('t3:tool:c3')).status).toBe('suspended');
  });

  it('replaying the same runId never reaches the semantic gate, so the embedding is not paid for twice', async () => {
    const journal = new InMemoryJournal();
    const embeds = { n: 0 };
    const limits = semLimits(fakeEmbed(embeds), 'replay-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => ({ ok: 1 }) } };
    await runDurable(base(journal, 'rp1', { model: model('createProduct', 'c1', { sku: 'X' })(), tools, threadId: 'th-R', limits }) as any);
    const after = embeds.n;
    await runDurable(base(journal, 'rp1', { model: model('createProduct', 'c1', { sku: 'X' })(), tools, threadId: 'th-R', limits }) as any);
    expect(embeds.n).toBe(after); // fast-path replay — embedder'a inilmedi
  });
});

describe('FAZ-6 decision gates (score alone never decides)', () => {
  it('identity mismatch: NO suspend, output byte-identical, telemetry only (the model is told nothing)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'id-model');
    const tools = {
      createProduct: {
        sideEffect: true,
        // A CONSTANT describe() gives every call the same canonical sentence → cosine 1.0 (maximum
        // similarity) — but the identity field DIFFERS, and score alone cannot suspend.
        semanticIdentity: { keys: ['sku'], describe: () => 'create a product' },
        execute: async ({ sku }: any) => { counter.n++; return { created: sku }; },
      },
    };
    await runDurable(base(journal, 's1', { model: model('createProduct', 'c1', { sku: 'AAA' })(), tools, threadId: 'th-S', limits }) as any);
    const r2 = await runDurable(base(journal, 's2', { model: model('createProduct', 'c2', { sku: 'BBB' })(), tools, threadId: 'th-S', limits }) as any);
    expect(counter.n).toBe(2); // it ran — 100% similarity still is not identity
    expect(JSON.stringify(r2.steps)).toContain('"created":"BBB"'); // ordinary output, no extra field
    expect(JSON.stringify(r2.steps)).not.toContain('semantic'); // the model-notification ban, pinned
    const incidents = await readIncidents(journal, 's2');
    expect(incidents.some((i) => i.source === 'semantic-guard' && i.action === 'warn')).toBe(true); // kalibrasyon telemetrisi
  });

  it('cross-tool negation: another tool is never a candidate (deleteProduct cannot see createProduct\'s record)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'x-model');
    const tools = {
      createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 'c' }; } },
      deleteProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 'd' }; } },
    };
    await runDurable(base(journal, 'x1', { model: model('createProduct', 'c1', { sku: 'ABC' })(), tools, threadId: 'th-X', limits }) as any);
    await runDurable(base(journal, 'x2', { model: model('deleteProduct', 'c2', { sku: 'ABC' })(), tools, threadId: 'th-X', limits }) as any);
    expect(counter.n).toBe(2); // a deletion is NOT a duplicate candidate for a creation
  });

  it("cross-tool negation holds when a tool name CONTAINS the key separator ('order' vs 'order-cancel')", async () => {
    // The filter used to rest entirely on the key prefix `sem-<toolName>-`, and a '-' in a tool name
    // makes that prefix ambiguous: scanning for 'order' also matched every 'order-cancel' key. The
    // cancellation then passed the identity phase and suspended the creation with ANOTHER tool's work
    // quoted back at the human — the exact cross-tool negation this gate exists to close.
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'dash-model');
    // A CONSTANT describe() on both tools, and the test is worthless without it. The default
    // canonical sentence embeds the tool name ('order: abc' vs 'order-cancel: abc'), so the fake
    // embedder hands back different vectors, cosine falls under minSimilarity, and the candidate
    // never reaches the gate this test claims to be testing — it passed with the gate deleted.
    // Measured: removing the toolName filter left this file green until this line existed.
    // Forcing one sentence for both puts cosine at 1.0, which is the only way the deterministic
    // toolName filter becomes the thing under test.
    const same = () => 'the same sentence for both tools';
    const tools = {
      'order': { sideEffect: true, semanticIdentity: { keys: ['sku'], describe: same }, execute: async () => { counter.n++; return { ok: 'o' }; } },
      'order-cancel': { sideEffect: true, semanticIdentity: { keys: ['sku'], describe: same }, execute: async () => { counter.n++; return { ok: 'x' }; } },
    };
    await runDurable(base(journal, 'd1', { model: model('order-cancel', 'c1', { sku: 'ABC' })(), tools, threadId: 'th-D', limits }) as any);
    await runDurable(base(journal, 'd2', { model: model('order', 'c2', { sku: 'ABC' })(), tools, threadId: 'th-D', limits }) as any);
    expect(counter.n).toBe(2);
  });

  it('thread isolation survives a threadId that CONTAINS the key pattern', async () => {
    // Second door onto the same ambiguity, and this one crosses the tenancy boundary rather than the
    // tool one: a thread literally named 'a:sem-order-x' writes to `xthr:a:sem-order-x:sem-order-<h>`,
    // which is under thread 'a''s scan prefix `xthr:a:sem-order-`. The tool names MATCH, so the
    // cross-tool check cannot see it — thread 'a' was suspended with the OTHER thread's canonical
    // sentence and the OTHER thread's firstToolCallId quoted into the human's question.
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'iso-model');
    const tools = { order: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'i1', { model: model('order', 'c1', { sku: 'ABC' })(), tools, threadId: 'a:sem-order-x', limits }) as any);
    await runDurable(base(journal, 'i2', { model: model('order', 'c2', { sku: 'ABC' })(), tools, threadId: 'a', limits }) as any);
    expect(counter.n).toBe(2); // another thread's work is never a candidate
  });

  it('intra-tool negation: a differing discriminator drops the candidate; an equal one suspends', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'd-model');
    const tools = {
      refund: {
        sideEffect: true,
        semanticIdentity: { keys: ['orderId'], discriminatorFields: ['cancel'] },
        execute: async () => { counter.n++; return { ok: 1 }; },
      },
    };
    await runDurable(base(journal, 'd1', { model: model('refund', 'c1', { orderId: 'O-1', cancel: false })(), tools, threadId: 'th-D', limits }) as any);
    // cancel:true is the OPPOSITE action → it must run
    await runDurable(base(journal, 'd2', { model: model('refund', 'c2', { orderId: 'O-1', cancel: true, note: 'z' })(), tools, threadId: 'th-D', limits }) as any);
    expect(counter.n).toBe(2);
    // cancel:false + the same orderId (different hash) = a real duplicate candidate → suspend
    await runDurable(base(journal, 'd3', { model: model('refund', 'c3', { orderId: 'O-1', cancel: false, note: 'w' })(), tools, threadId: 'th-D', limits }) as any);
    expect(counter.n).toBe(2);
    expect((await journal.get<any>('d3:tool:c3')).status).toBe('suspended');
  });

  it('the magnitude gate: identity equal + amount different → a suspend that says "amounts differ"', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'a-model');
    const tools = {
      charge: {
        sideEffect: true,
        semanticIdentity: { keys: ['orderId'], amountFields: ['amount'] },
        execute: async () => { counter.n++; return { ok: 1 }; },
      },
    };
    await runDurable(base(journal, 'a1', { model: model('charge', 'c1', { orderId: 'O-9', amount: 99.9 })(), tools, threadId: 'th-M', limits }) as any);
    await runDurable(base(journal, 'a2', { model: model('charge', 'c2', { orderId: 'O-9', amount: 9990 })(), tools, threadId: 'th-M', limits }) as any);
    expect(counter.n).toBe(1);
    const rec = await journal.get<any>('a2:tool:c2');
    expect(rec.status).toBe('suspended');
    expect(rec.output.__gnl_suspend.reason).toContain('amounts differ');
  });
});

describe('FAZ-6 fail-open, stamps and lifecycle', () => {
  it('a broken embedder: the record is written without a vector, work is never blocked, and the third consecutive failure raises an outage incident', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const brokenEmbed = async () => { throw new Error('embedder down'); };
    const limits = semLimits(brokenEmbed as any, 'down-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'f1', { model: model('createProduct', 'c1', { sku: 'A' })(), tools, threadId: 'th-F', limits }) as any);
    await runDurable(base(journal, 'f2', { model: model('createProduct', 'c2', { sku: 'B' })(), tools, threadId: 'th-F', limits }) as any);
    await runDurable(base(journal, 'f3', { model: model('createProduct', 'c3', { sku: 'C' })(), tools, threadId: 'th-F', limits }) as any);
    expect(counter.n).toBe(3); // no work was blocked
    const rec = await journal.get<SemDupRecord>(semKey('th-F', 'createProduct', (await journal.listKeys('xthr:th-F:sem-'))[0]!.split('-').pop()!));
    // the records exist, but carry no vector:
    const keys = await journal.listKeys('xthr:th-F:sem-');
    expect(keys.length).toBe(3);
    for (const k of keys) expect((await journal.get<SemDupRecord>(k))!.vecB64).toBeUndefined();
    // the third consecutive failure → one outage incident (inside f3's run)
    const inc3 = await readIncidents(journal, 'f3');
    expect(inc3.some((i) => i.source === 'semantic-guard' && String(i.message).includes('failed repeatedly'))).toBe(true);
  });

  it('a record stamped with a different embedModelId is never compared', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'model-B');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'm1', { model: model('createProduct', 'c1', { sku: 'S' })(), tools, threadId: 'th-V', limits }) as any);
    // corrupt the record's stamp to 'model-A', as if the model had been swapped
    const k = (await journal.listKeys('xthr:th-V:sem-'))[0]!;
    const rec = await journal.get<SemDupRecord>(k);
    await journal.put(k, { ...rec, embedModelId: 'model-A' });
    await runDurable(base(journal, 'm2', { model: model('createProduct', 'c2', { sku: 'S', note: 'y' })(), tools, threadId: 'th-V', limits }) as any);
    expect(counter.n).toBe(2); // the stale-stamped record was excluded → no question, the work ran
  });

  it('purgeThread takes the sem and semtomb families in a single sweep', async () => {
    const journal = new InMemoryJournal();
    await journal.put(semKey('th-P', 't', 'h1'), { v: 1 });
    await journal.put(semTombKey('th-P', 't', 'h1', 'h2'), { at: 1 });
    await purgeThread(journal, 'th-P');
    expect(await journal.listKeys('xthr:th-P:')).toEqual([]);
  });

  it('without a threadId: a loud warn, the layer stands down, work runs normally, xthr stays empty', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'nt-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(journal, 'nt1', { model: model('createProduct', 'c1', { sku: 'Q' })(), tools, limits }) as any);
      expect(counter.n).toBe(1);
      expect(warn.mock.calls.some((c) => String(c[0]).includes('semantic guard'))).toBe(true);
      expect(await journal.listKeys('xthr:')).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });

  it('an identity declaration that cannot identify the call stands the layer down — and says so', async () => {
    // The panel's conscious-risk list predicted a bad `keys` declaration would quietly DISABLE the
    // layer. Measured, it did the opposite: identity '[object object]' (an object-valued key) or ''
    // (a misspelled key) compares equal to itself on every call, cosine is 1.0, and EVERY call after
    // the first became an approval question — with the scan counters at zero, so nothing explained
    // why. A question storm is how an operator learns to approve without reading.
    const run = async (name: string, semanticIdentity: unknown, a1: unknown, a2: unknown) => {
      const journal = new InMemoryJournal();
      const counter = { n: 0 };
      const limits = semLimits(fakeEmbed(), `${name}-model`);
      const tools = { act: { sideEffect: true, semanticIdentity, execute: async () => { counter.n++; return { ok: 1 }; } } };
      await runDurable(base(journal, `${name}1`, { model: model('act', 'c1', a1)(), tools, threadId: `th-${name}`, limits }) as any);
      await runDurable(base(journal, `${name}2`, { model: model('act', 'c2', a2)(), tools, threadId: `th-${name}`, limits }) as any);
      return { ran: counter.n, inc: await readIncidents(journal, `${name}2`) };
    };
    const unusable = (r: { inc: Awaited<ReturnType<typeof readIncidents>> }) =>
      r.inc.some((i) => i.source === 'semantic-guard' && (i.detail as any)?.reason === 'identity-unusable');

    // An object-valued key: every payload stringifies to the same thing.
    const obj = await run('uo', { keys: ['payload'] }, { payload: { sku: 'A-1' } }, { payload: { sku: 'Z-9' } });
    expect(obj.ran).toBe(2);
    expect(unusable(obj)).toBe(true);

    // A misspelled key ('userID' vs the actual 'userId'): every identity is ''.
    const typo = await run('ut', { keys: ['userID'] }, { userId: 'u-7' }, { userId: 'u-99' });
    expect(typo.ran).toBe(2);
    expect(unusable(typo)).toBe(true);

    // An array-valued key: [1,2] and ['1','2'] both stringify to '1,2'.
    const arr = await run('ua', { keys: ['items'] }, { items: [1, 2] }, { items: ['1', '2'] });
    expect(arr.ran).toBe(2);
    expect(unusable(arr)).toBe(true);
    // ...and it says WHY. An array is not the object case: `['a','b']` and `['c','d']` genuinely
    // differ, so "every call would compare equal" is false here. An operator who reads that and then
    // watches calls not compare equal stops believing the next diagnostic too.
    expect(arr.inc.find((i) => i.source === 'semantic-guard')?.message ?? '')
      .toMatch(/element types flatten/);

    // THE LINE THIS MUST NOT CROSS — the rule is "EVERY key empty", not "any key empty". An optional
    // field absent on both sides is a legitimate identity, and the question still gets asked.
    const partial = await run('up', { keys: ['sku', 'warehouse'] }, { sku: 'ABC', note: 'ilk' }, { sku: 'ABC', note: 'ikinci' });
    expect(partial.ran).toBe(1); // second call suspended, as it should be
    expect(unusable(partial)).toBe(false);
    expect(partial.inc.some((i) => i.source === 'semantic-guard' && i.action === 'suspend')).toBe(true);

    // A sound declaration with genuinely different identities is untouched.
    const sound = await run('us', { keys: ['sku'] }, { sku: 'ABC' }, { sku: 'XYZ' });
    expect(sound.ran).toBe(2);
    expect(unusable(sound)).toBe(false);
  });

  // Deliberately a UNIT test on the function, not another end-to-end run. The flow above reports one
  // incident whichever branch fires, so it cannot tell WHICH guard caught a case — and a test that
  // passes for the wrong reason is the failure mode this suite keeps finding. Each branch below was
  // verified by removing exactly that branch and watching only its own assertion turn red.
  it('identityUnusableReason: what identifies a call, and what only looks like it does', async () => {
    const { identityUnusableReason } = await import('../src/semantic-dup.js');
    const reason = (keys: string[], args: unknown) => identityUnusableReason({ keys } as never, args);

    // A DATE identifies. `String(d)` varies per call, so calling it unusable would stand the layer
    // down on a declaration that works — a protection switched off by an upgrade, silently.
    expect(reason(['when'], { when: new Date('2026-01-01T00:00:00Z') })).toBeUndefined();

    // …but an INVALID one is the exception, and it is exactly the failure this function exists to
    // name: every unparseable date stringifies to the same 'Invalid Date', so two completely
    // different bad inputs compare EQUAL. Measured before this branch: `new Date('not-a-date')` and
    // `new Date('also-garbage')` both normalized to 'invalid date' and the guard said the
    // declaration was fine. `z.coerce.date()` on a malformed string produces precisely this.
    for (const bad of [new Date('not-a-date'), new Date(NaN)]) {
      expect(reason(['when'], { when: bad }), 'an Invalid Date identifies nothing').toMatch(/Invalid Date/);
    }
    expect(reason(['sku'], { sku: 'A-1' })).toBeUndefined();

    // A plain object does not. Every one of them is '[object Object]'.
    expect(reason(['payload'], { payload: { sku: 'A' } })).toMatch(/carries no identity/);

    // An array does not either, but for a DIFFERENT reason, and the message has to carry the real
    // one: `['a','b']` and `['c','d']` do differ, so "every call would compare equal" is false here.
    // What actually breaks is that element types flatten — [1,2] and ['1','2'] both become '1,2'.
    expect(reason(['items'], { items: [1, 2] })).toMatch(/element types flatten/);

    // THE GUARD'S OWN TARGET, which it used to miss. `constructor` resolves to Object and `toString`
    // to a function through the PROTOTYPE: both are non-null, both sailed past a bare
    // `typeof v === 'object'` test, and both normalize to one constant for every call — precisely the
    // "every call compares equal" failure this function exists to name. Measured before the fix:
    // `undefined`, i.e. "this declaration is fine".
    for (const k of ['constructor', 'toString', 'valueOf']) {
      expect(reason([k], { sku: 'A' }), `keys: ['${k}'] reaches the prototype and identifies nothing`)
        .toBeDefined();
    }

    // The second half of the same lesson, and a separate branch: a key that exists ONLY on the
    // prototype is not an argument the caller passed. Reading it through the chain reports a sound
    // declaration for a field the tool never received.
    const inherited = Object.create({ sku: 'inherited-value' });
    expect(reason(['sku'], inherited), 'a prototype-only key is not an argument').toBeDefined();

    // A function held as an OWN property is its own case, and the only one the `typeof` branch
    // catches by itself — the prototype names above are already stopped one line earlier. Without it
    // a function falls through every object test (`typeof fn` is 'function', not 'object') and then
    // normalizes to its source text, which is non-empty, so the declaration reads as sound.
    // Measured: removing that branch alone left this suite green until this assertion existed.
    expect(reason(['sku'], { sku: () => 1 }), 'a function argument identifies nothing').toBeDefined();
  });

  it("a describe() that THROWS stands the layer down for that call — it does not take the tool call with it", async () => {
    // `describe` is caller code running over MODEL-produced args, so an omitted optional field is
    // enough to make it throw. Unguarded, that throw turned a call which succeeds WITHOUT the layer
    // into a failure — the inverse of the fail-open promise. The layer is OFF for the call (and the
    // default template is deliberately NOT used as a fallback: describe is the PII redaction point).
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'thr-model');
    const tools = {
      createProduct: {
        sideEffect: true,
        semanticIdentity: { keys: ['sku'], describe: (a: any) => a.meta.label as string },
        execute: async () => { counter.n++; return { ok: 1 }; },
      },
    };
    await runDurable(base(journal, 'dt1', { model: model('createProduct', 'c1', { sku: 'Q' })(), tools, threadId: 'th-T', limits }) as any);
    expect(counter.n).toBe(1);
    expect(await journal.listKeys('xthr:th-T:sem-')).toEqual([]); // no record, no half-written vector
    const inc = await readIncidents(journal, 'dt1');
    expect(inc.some((i) => i.source === 'semantic-guard' && (i.detail as any)?.reason === 'identity-build-failed')).toBe(true);
  });
});

// Findings from the FAZ-6 audit — the K18 pin, the frozen-limits round trip, the concurrent
// paraphrase twin, and the two fallback arms.
import { resumeRun } from '../src/run.js';

describe('FAZ-6 audit fixes', () => {
  it("K18: a failed record is NOT overwritten by a semantic suspend — the reclaim ladder keeps ownership", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    let explode = true;
    const limits = semLimits(fakeEmbed(), 'k18-model');
    const tools = {
      charge: {
        sideEffect: true,
        semanticIdentity: { keys: ['orderId'] },
        execute: async () => { counter.n++; if (explode) throw new Error('timeout — effect uncertain'); return { ok: 1 }; },
      },
    };
    // There IS a similar past success (it will produce a semantic candidate):
    await runDurable(base(journal, 'k1', { model: model('charge', 'c1', { orderId: 'O-7', note: 'first' })(), tools, threadId: 'th-K', limits }) as any).catch(() => {});
    expect(counter.n).toBe(1); // the first attempt fired and crashed → the record is 'failed'
    expect((await journal.get<any>('k1:tool:c1')).status).toBe('failed');
    explode = false;
    // Resume without approval: the old code found a semantic candidate and overwrote 'failed' with
    // 'suspended' ("similar work — shall I run it?"), hiding that THIS attempt may already have
    // fired. Now the record stands, the reclaim ladder answers (side-effect + unapproved → blocked),
    // and the effect is never re-fired.
    await runDurable(base(journal, 'k1', { model: model('charge', 'c1', { orderId: 'O-7', note: 'first' })(), tools, threadId: 'th-K', limits }) as any).catch(() => {});
    const rec = await journal.get<any>('k1:tool:c1');
    expect(rec.status).toBe('failed'); // ezilmedi
    expect(counter.n).toBe(1); // not re-fired
  });

  it('frozen-limits round trip: resumeRun without limits does NOT throw — the layer is inactive and the work runs', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'rt-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'rr1', { model: model('createProduct', 'c1', { sku: 'R-1' })(), tools, threadId: 'th-RT', limits }) as any);
    // resume without limits → the stripped (embedStripped) copy from the journal is used. The old
    // code threw inside validateSemanticConfig, which killed the resume of EVERY semantic-active run.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(resumeRun('rr1', { journal, model: model('createProduct', 'c1', { sku: 'R-1' })(), tools } as any)).resolves.toBeTruthy();
      expect(counter.n).toBe(1); // replay — nothing re-fires
    } finally { warn.mockRestore(); }
  });

  it('semantic suspend → resumeRun(approvals) end to end: the approval runs and a tombstone is born', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'ap-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'ap1', { model: model('createProduct', 'c1', { sku: 'A-1', note: 'first' })(), tools, threadId: 'th-AP', limits }) as any);
    await runDurable(base(journal, 'ap2', { model: model('createProduct', 'c2', { sku: 'A-1', note: 'again' })(), tools, threadId: 'th-AP', limits }) as any);
    expect(counter.n).toBe(1); // suspend
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // The real approval path: resumeRun recovers limits (stripped) from the journal, and the
      // approval must still flow through.
      await resumeRun('ap2', { journal, model: model('createProduct', 'c2', { sku: 'A-1', note: 'again' })(), tools, approvals: { 'c2': true } } as any);
    } finally { warn.mockRestore(); }
    expect(counter.n).toBe(2); // the approved work ran
    expect(await journal.listKeys('xthr:th-AP:semtomb-')).toHaveLength(1); // the ruling was tombstoned
  });

  it('concurrent paraphrase twins (the documented TOCTOU): both run, two records, no suspend', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'tw-model');
    const tools = {
      createProduct: {
        sideEffect: true,
        semanticIdentity: { keys: ['sku'] },
        execute: async () => { counter.n++; await new Promise((r) => setTimeout(r, 15)); return { ok: 1 }; },
      },
    };
    await Promise.all([
      runDurable(base(journal, 'tp1', { model: model('createProduct', 'c1', { sku: 'TW', note: 'a' })(), tools, threadId: 'th-TW', limits }) as any),
      runDurable(base(journal, 'tp2', { model: model('createProduct', 'c2', { sku: 'TW', note: 'b' })(), tools, threadId: 'th-TW', limits }) as any),
    ]);
    expect(counter.n).toBe(2); // the window is real: two different-hash twins cannot see each other in recall
    expect((await journal.listKeys('xthr:th-TW:sem-')).length).toBe(2);
    // This layer promises to catch duplicates SPREAD OVER TIME; concurrency belongs to the exact-hash and lock layers.
  });

  it("a journal without listKeys: the layer stands down loudly and work runs normally", async () => {
    const m = new Map<string, unknown>();
    const journal: any = {
      async get(k: string) { return m.has(k) ? structuredClone(m.get(k)) : undefined; },
      async put(k: string, v: unknown) { m.set(k, structuredClone(v)); },
      async putIfAbsent(k: string, v: unknown) { if (m.has(k)) return false; m.set(k, structuredClone(v)); return true; },
    };
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'nl-model');
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await runDurable(base(journal, 'nl1', { model: model('createProduct', 'c1', { sku: 'N', note: 'a' })(), tools, threadId: 'th-NL', limits }) as any);
      await runDurable(base(journal, 'nl2', { model: model('createProduct', 'c2', { sku: 'N', note: 'b' })(), tools, threadId: 'th-NL', limits }) as any);
      expect(counter.n).toBe(2); // the recall scan is off — work was never blocked
      expect(warn.mock.calls.some((c) => String(c[0]).includes('listKeys'))).toBe(true);
    } finally { warn.mockRestore(); }
  });

  it('ttlMs: a semantic record past its window stops being a candidate (aged by the storage clock)', async () => {
    const base2 = new InMemoryJournal();
    const clock = { t: 5_000_000 };
    const journal: any = new Proxy(base2, {
      get: (t, p) => (p === 'now' ? async () => clock.t : (t as any)[p] instanceof Function ? (t as any)[p].bind(t) : (t as any)[p]),
    });
    const counter = { n: 0 };
    const limits = { sideEffectDuplicates: { action: 'suspend' as const, scope: 'thread' as const, ttlMs: 1_000, semantic: { embed: fakeEmbed(), embedModelId: 'ttl-model' } } };
    const tools = { createProduct: { sideEffect: true, semanticIdentity: { keys: ['sku'] }, execute: async () => { counter.n++; return { ok: 1 }; } } };
    await runDurable(base(journal, 'tl1', { model: model('createProduct', 'c1', { sku: 'T', note: 'a' })(), tools, threadId: 'th-TL', limits }) as any);
    clock.t += 2_000; // the window has passed (the exact marker ages on the same ttl)
    await runDurable(base(journal, 'tl2', { model: model('createProduct', 'c2', { sku: 'T', note: 'b' })(), tools, threadId: 'th-TL', limits }) as any);
    expect(counter.n).toBe(2); // the aged-out record produced no question
  });
});

// ── FAZ-7 (semantic v2) — the rule ladder and the judge chain ─────────────────────────────────
// Pinned here: (1) MONOTONICITY (H17) — v2 never takes away a question v1 would have asked;
// (2) a ladder 'match' produces a deterministic suspend, a 'separate' drops quietly but is COUNTED;
// (3) the judge only ever sees the gray residue, and even a 'same' answer only asks a human;
// (4) ONE combined scan incident (H16); (5) the model is told nothing on every arm;
// (6) a discriminator difference never REACHES the judge.

const certOf = (over: Record<string, unknown> = {}) => ({
  v: 1 as const, fixtureSetId: 'fx-test', judgeModelId: 'j-model', judgePromptVersion: '1',
  paraphraseRecall: 0.95, nearMissFp: 0.01, passedAt: Date.now(), ...over,
});

describe('FAZ-7 rule ladder (deterministic, no judge)', () => {
  it("ladder 'match': a differently-spelled but structurally identical identity → suspend (origin:'rule')", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'r-model', { rules: true });
    const tools = {
      pay: { sideEffect: true, semanticIdentity: { keys: ['ref'], describe: () => 'pay an invoice' },
        execute: async ({ ref }: any) => { counter.n++; return { paid: ref }; } },
    };
    await runDurable(base(journal, 'rl1', { model: model('pay', 'c1', { ref: 'INV-2026-0142' })(), tools, threadId: 'th-RL', limits }) as any);
    const r2 = await runDurable(base(journal, 'rl2', { model: model('pay', 'c2', { ref: 'inv 2026 142' })(), tools, threadId: 'th-RL', limits }) as any);
    expect(counter.n).toBe(1); // the second job did NOT run — a human was asked
    expect(r2.interrupts.length).toBe(1);
    const inc = (await readIncidents(journal, 'rl2')).find((i) => i.action === 'suspend');
    expect(inc?.source).toBe('semantic-guard');
    expect((inc?.detail as any).origin).toBe('rule');
    expect((inc?.detail as any).trace.map((t: any) => t.rule)).toContain('digit-value');
  });

  it("ladder 'separate': XL is not XXL — the candidate drops quietly but is COUNTED (work runs, output byte-identical)", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'r2-model', { rules: true });
    const tools = {
      order: { sideEffect: true, semanticIdentity: { keys: ['sku'], describe: () => 'order a product' },
        execute: async ({ sku }: any) => { counter.n++; return { ordered: sku }; } },
    };
    await runDurable(base(journal, 'sp1', { model: model('order', 'c1', { sku: 'PHI-AF-XL' })(), tools, threadId: 'th-SP', limits }) as any);
    const r2 = await runDurable(base(journal, 'sp2', { model: model('order', 'c2', { sku: 'PHI-AF-XXL' })(), tools, threadId: 'th-SP', limits }) as any);
    expect(counter.n).toBe(2); // a different size is different work; NO question
    expect(JSON.stringify(r2.steps)).not.toContain('semantic'); // the model is told nothing
    const warn = (await readIncidents(journal, 'sp2')).find((i) => i.source === 'semantic-guard' && i.action === 'warn');
    expect((warn?.detail as any).droppedByRule).toBe(1); // NOT silent: counted and named
  });

  it('MONOTONICITY (H17): a high-scoring gray candidate cannot displace an identity-equal one\'s question', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    // Two prior records: one identity-equal (it must produce the question), one merely gray. The
    // fake embedder scores by canonical text, and since describe() is constant both score 1.0 —
    // so the loop's ordering is what has to hold.
    const limits = semLimits(fakeEmbed(), 'm-model', { rules: true });
    const tools = {
      pay: { sideEffect: true, semanticIdentity: { keys: ['ref'], describe: () => 'pay' },
        execute: async ({ ref }: any) => { counter.n++; return { paid: ref }; } },
    };
    await runDurable(base(journal, 'mo1', { model: model('pay', 'c1', { ref: 'coupon code invalid', note: 'x' })(), tools, threadId: 'th-MO', limits }) as any);
    await runDurable(base(journal, 'mo2', { model: model('pay', 'c2', { ref: 'AYNI-REF', note: 'x' })(), tools, threadId: 'th-MO', limits }) as any);
    expect(counter.n).toBe(2);
    // Third call: the identity is NORMALIZE-EQUAL ('ayni-ref') while the args differ byte-wise
    // (lower case + a note), so the exact-hash layer misses it and the semantic layer sees it. A
    // gray candidate is in the list too — and the certain question must still win.
    const r3 = await runDurable(base(journal, 'mo3', { model: model('pay', 'c3', { ref: 'ayni-ref', note: 'y' })(), tools, threadId: 'th-MO', limits }) as any);
    expect(counter.n).toBe(2);
    expect(r3.interrupts.length).toBe(1);
    const inc = (await readIncidents(journal, 'mo3')).find((i) => i.action === 'suspend');
    expect((inc?.detail as any).origin).toBe('identity'); // v1's certain question won
  });
});

describe('FAZ-7 judge chain', () => {
  const judgeTools = (counter: { n: number }) => ({
    pay: { sideEffect: true, semanticIdentity: { keys: ['ref'], describe: () => 'pay' },
      execute: async ({ ref }: any) => { counter.n++; return { paid: ref }; } },
  });

  it("judge says 'same' → a QUESTION for the human (the decision stays theirs), incident source 'semantic-judge'", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const calls: Array<{ system: string; user: string }> = [];
    const limits = semLimits(fakeEmbed(), 'j-embed', {
      rules: true,
      judge: { complete: async (req: any) => { calls.push(req); return 'SAME'; }, judgeModelId: 'j-model', qualification: certOf() },
    });
    const tools = judgeTools(counter);
    await runDurable(base(journal, 'jg1', { model: model('pay', 'c1', { ref: 'Coupon code invalid' })(), tools, threadId: 'th-JG', limits }) as any);
    const r2 = await runDurable(base(journal, 'jg2', { model: model('pay', 'c2', { ref: 'Discount code not working' })(), tools, threadId: 'th-JG', limits }) as any);
    expect(counter.n).toBe(1); // the second job did not run
    expect(r2.interrupts.length).toBe(1);
    const inc = (await readIncidents(journal, 'jg2')).find((i) => i.action === 'suspend');
    expect(inc?.source).toBe('semantic-judge');
    expect((inc?.detail as any).judgeModelId).toBe('j-model');
    // The judge is never told the work ran before (the model-notification ban, projected here)
    expect(calls).toHaveLength(1);
    expect(`${calls[0]!.system}${calls[0]!.user}`.toLowerCase()).not.toMatch(/already|earlier|previous|duplicate/);
  });

  it("judge says 'different' → today's behavior plus a de-escalation RECORD (never silent)", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'j2-embed', {
      rules: true,
      judge: { complete: async () => 'DIFFERENT', judgeModelId: 'j-model', qualification: certOf() },
    });
    const tools = judgeTools(counter);
    await runDurable(base(journal, 'jd1', { model: model('pay', 'c1', { ref: 'Coupon code invalid' })(), tools, threadId: 'th-JD', limits }) as any);
    const r2 = await runDurable(base(journal, 'jd2', { model: model('pay', 'c2', { ref: 'Discount code not working' })(), tools, threadId: 'th-JD', limits }) as any);
    expect(counter.n).toBe(2);
    expect(JSON.stringify(r2.steps)).not.toContain('semantic'); // output byte-identical: nothing reaches the model
    const warn = (await readIncidents(journal, 'jd2')).find((i) => i.source === 'semantic-judge' && i.action === 'warn');
    expect((warn?.detail as any).outcome).toBe('different');
  });

  it('even when the judge crashes the work runs (fail-open) and the cause is recorded', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'j3-embed', {
      rules: true,
      judge: { complete: async () => { throw new Error('down'); }, judgeModelId: 'j-model', qualification: certOf() },
    });
    const tools = judgeTools(counter);
    await runDurable(base(journal, 'je1', { model: model('pay', 'c1', { ref: 'Coupon code invalid' })(), tools, threadId: 'th-JE', limits }) as any);
    await runDurable(base(journal, 'je2', { model: model('pay', 'c2', { ref: 'Discount code not working' })(), tools, threadId: 'th-JE', limits }) as any);
    expect(counter.n).toBe(2);
    const warn = (await readIncidents(journal, 'je2')).find((i) => i.source === 'semantic-judge' && i.action === 'warn');
    expect((warn?.detail as any).outcome).toBe('skipped:error');
  });

  it('a discriminator difference never REACHES the judge (deterministic negation comes first)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const judgeFn = vi.fn(async () => 'SAME');
    const limits = semLimits(fakeEmbed(), 'j4-embed', {
      rules: true,
      judge: { complete: judgeFn, judgeModelId: 'j-model', qualification: certOf() },
    });
    const tools = {
      refund: { sideEffect: true, semanticIdentity: { keys: ['ref'], discriminatorFields: ['cancel'], describe: () => 'refund' },
        execute: async () => { counter.n++; return { ok: 1 }; } },
    };
    await runDurable(base(journal, 'dc1', { model: model('refund', 'c1', { ref: 'R-1', cancel: false })(), tools, threadId: 'th-DC', limits }) as any);
    await runDurable(base(journal, 'dc2', { model: model('refund', 'c2', { ref: 'R-2', cancel: true })(), tools, threadId: 'th-DC', limits }) as any);
    expect(counter.n).toBe(2);
    expect(judgeFn).not.toHaveBeenCalled();
    const warn = (await readIncidents(journal, 'dc2')).find((i) => i.source === 'semantic-guard' && i.action === 'warn');
    expect((warn?.detail as any).droppedDiscriminator).toBe(1); // H18: now counted
  });

  it('H16: the scan counters live in ONE combined incident — none of them overwrites another', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'h16-embed', { rules: true });
    const tools = {
      pay: { sideEffect: true, semanticIdentity: { keys: ['ref'], discriminatorFields: ['kind'], describe: () => 'pay' },
        execute: async () => { counter.n++; return { ok: 1 }; } },
    };
    // Three different drop reasons in one scan: discriminator, rule, identity
    await runDurable(base(journal, 'h1', { model: model('pay', 'c1', { ref: 'TV-42', kind: 'a' })(), tools, threadId: 'th-H16', limits }) as any);
    await runDurable(base(journal, 'h2', { model: model('pay', 'c2', { ref: 'ZZZ-9', kind: 'b' })(), tools, threadId: 'th-H16', limits }) as any);
    await runDurable(base(journal, 'h3', { model: model('pay', 'c3', { ref: 'TV-43', kind: 'a' })(), tools, threadId: 'th-H16', limits }) as any);
    const warns = (await readIncidents(journal, 'h3')).filter((i) => i.source === 'semantic-guard' && i.action === 'warn');
    expect(warns).toHaveLength(1); // ONE record — not three that collide on the same key
    const d = warns[0]!.detail as any;
    expect((d.droppedByRule ?? 0) + (d.droppedDiscriminator ?? 0)).toBeGreaterThan(0);
  });

  it('without a judge the gray residue is still COUNTED (grayCalls: the price quote, in CALLS) and work runs', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'gu-embed', { rules: true });
    const tools = judgeTools(counter);
    await runDurable(base(journal, 'gu1', { model: model('pay', 'c1', { ref: 'Coupon code invalid' })(), tools, threadId: 'th-GU', limits }) as any);
    await runDurable(base(journal, 'gu2', { model: model('pay', 'c2', { ref: 'Discount code not working' })(), tools, threadId: 'th-GU', limits }) as any);
    expect(counter.n).toBe(2);
    const warn = (await readIncidents(journal, 'gu2')).find((i) => i.source === 'semantic-guard' && i.action === 'warn');
    // The unit is CALLS: one call, one count, however many candidates it surfaced — that is what a
    // judge would have cost, and it does not shift when the judge is later switched on.
    expect((warn?.detail as any).grayCalls).toBe(1);
  });

  it('an uncertified judge throws BEFORE the run starts (silent inertness is impossible)', async () => {
    const journal = new InMemoryJournal();
    const limits = semLimits(fakeEmbed(), 'bad-embed', {
      rules: true, judge: { complete: async () => 'SAME', judgeModelId: 'j-model' },
    });
    const tools = judgeTools({ n: 0 });
    await expect(runDurable(base(journal, 'bad1', { model: model('pay', 'c1', { ref: 'A' })(), tools, threadId: 'th-BAD', limits }) as any))
      .rejects.toThrow(/qualification/);
  });

  it('frozen-limits round trip: the judge closure is stripped, resume does not throw, the layer is inactive', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const limits = semLimits(fakeEmbed(), 'fz-embed', {
      rules: true, judge: { complete: async () => 'SAME', judgeModelId: 'j-model', qualification: certOf() },
    });
    const tools = judgeTools(counter);
    const r1 = await runDurable(base(journal, 'fz1', { model: model('pay', 'c1', { ref: 'AAA-1' })(), tools, threadId: 'th-FZ', limits }) as any);
    expect(r1.interrupts.length).toBe(0);
    // resume without limits: the frozen copy is read from the journal — no closure, but the data survives
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      await expect(resumeRun('fz1', { journal, model: model('pay', 'c1', { ref: 'AAA-1' })(), tools } as any)).resolves.toBeTruthy();
    } finally { warn.mockRestore(); }
    // Unconditional: this is the ONLY pin for a claim the plan marked blocker-level (an unstripped
    // judge closure kills the journal write of every judge-enabled run). A conditional assert would
    // stay green if the key were ever renamed.
    const frozen = await journal.get<any>('fz1:cfg:limits');
    expect(frozen).toBeTruthy();
    {
      expect(frozen.sideEffectDuplicates.semantic.judge?.complete).toBeUndefined(); // closure soyuldu
      expect(frozen.sideEffectDuplicates.semantic.judge?.qualification).toBeTruthy(); // the declaration survives
      expect(frozen.sideEffectDuplicates.semantic.rules).toBe(true); // saf veri aynen
    }
  });
});
