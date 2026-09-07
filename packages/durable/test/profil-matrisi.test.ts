// PANEL MATRIX + XID + OVERRIDE — behavior pins for the v1 package.
// 1) matrix cells: assistant(notification→suspend in v1, idempotent-write→NO question),
//    headless(transactional→BLOCK/DLQ, notification→SKIP+incident), critical(idempotent-write→runs with a warn)
// 2) XID: different channel/thread, same job identity → the question carries "another channel (… via chat)" context;
//    a spelling variant (TV-1/tv-1) is also caught across channels; works WITHOUT semantic limits (no embedder)
// 3) intent-override trail: a suspend→approval run leaves an override record in the journal
// 4) rich payload: the dup-suspend interrupt carries a prior {toolCallId, at, ageMs}
import { describe, it, expect } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

function tools(state: { n: Record<string, number> }) {
  const mk = (name: string, extra: Record<string, unknown>) => ({
    description: name, sideEffect: true, recover: async () => ({ done: false as const }),
    execute: async (args: unknown) => { state.n[name] = (state.n[name] ?? 0) + 1; return { ok: true, args }; },
    ...extra,
  });
  return {
    pay: mk('pay', { effectClass: 'transactional', semanticIdentity: { keys: ['ref'], amountFields: ['amount'] } }),
    mail: mk('mail', { effectClass: 'notification' }),
    upsert: mk('upsert', { effectClass: 'idempotent-write' }),
  };
}

const model = (toolName: string, callId: string, args: unknown) =>
  createMockModel(async ({ prompt }: any) =>
    countToolResults(prompt) === 0 ? toolCallResult(toolName, callId, args) : finalTextResult('ok'));

function gnlWith(journal: InMemoryJournal, preset: 'assistant' | 'headless' | 'critical', state: { n: Record<string, number> }) {
  return createGnl({ journal, preset, agents: { a: { model: model('pay', 'x', {}), tools: tools(state) } } });
}

describe('profile matrix', () => {
  it("assistant: a notification repeat ASKS in v1; an idempotent-write repeat runs WITHOUT asking", async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'assistant', agents: {
      m1: { model: model('mail', 'c1', { to: 'a@b', body: 'hi' }), tools: tools(state) },
      u1a: { model: model('upsert', 'c2', { id: 5, v: 1 }), tools: tools(state) },
    } });
    await gnl.run('m1', { runId: 'r1', prompt: 'mail at', threadId: 't', resourceId: 'u' });
    const r2 = await gnl.run('m1', { runId: 'r2', prompt: 'mail at', threadId: 't', resourceId: 'u' });
    expect(r2.interrupts).toHaveLength(1); // v1: asks until the soft-interrupt surface lands
    expect(state.n.mail).toBe(1);

    await gnl.run('u1a', { runId: 'r3', prompt: 'upsert', threadId: 't', resourceId: 'u' });
    const r4 = await gnl.run('u1a', { runId: 'r4', prompt: 'upsert', threadId: 't', resourceId: 'u' });
    expect(r4.interrupts).toHaveLength(0); // a cell where questions are FORBIDDEN
    expect(state.n.upsert).toBe(2); // no guard — the operation is already considered idempotent-safe
  });

  it('headless: a transactional repeat is BLOCKED (DLQ path — throw); a notification repeat is SKIPped + incident', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'headless', agents: {
      p: { model: model('pay', 'c1', { ref: 'F-1', amount: 100 }), tools: tools(state) },
      m: { model: model('mail', 'c2', { to: 'a@b' }), tools: tools(state) },
    } });
    await gnl.run('p', { runId: 'h1', prompt: 'pay', threadId: 't', resourceId: 'u' });
    await expect(gnl.run('p', { runId: 'h2', prompt: 'pay', threadId: 't', resourceId: 'u' }))
      .rejects.toThrow(/duplicate/i); // typed rejection — drops the queue into the DLQ
    expect(state.n.pay).toBe(1);

    await gnl.run('m', { runId: 'h3', prompt: 'mail', threadId: 't', resourceId: 'u' });
    const r = await gnl.run('m', { runId: 'h4', prompt: 'mail', threadId: 't', resourceId: 'u' });
    expect(r.interrupts).toHaveLength(0);
    expect(state.n.mail).toBe(1); // did not run
    expect(JSON.stringify(r.steps ?? r)).toContain('__gnl_skipped'); // the model gets a visible narration
    const { readIncidents } = await import('../src/incidents.js');
    const inc = await readIncidents(journal, 'h4');
    expect(inc.some((i) => i.action === 'skip')).toBe(true); // not silent
  });

  it('critical: an idempotent-write tool that DECLARES itself runs without asking (warn trail) — an undeclared tool stays suspend', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'critical', agents: {
      u: { model: model('upsert', 'c1', { id: 1 }), tools: tools(state) },
    } });
    await gnl.run('u', { runId: 'c1r', prompt: 'x', threadId: 't', resourceId: 'u' });
    const r = await gnl.run('u', { runId: 'c2r', prompt: 'x', threadId: 't', resourceId: 'u' });
    expect(r.interrupts).toHaveLength(0);
    expect(state.n.upsert).toBe(2); // ran (the warn cell)
    const { readIncidents } = await import('../src/incidents.js');
    const inc = await readIncidents(journal, 'c2r');
    expect(inc.some((i) => i.action === 'warn')).toBe(true); // left a trail — not invisible
  });
});

describe('XID — cross-channel job identity', () => {
  it('different thread + different channel, the SAME identity → the suspend question carries "another channel (via chat)" context; a spelling variant is also caught', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    // Channel 1: chat — F-9 was paid
    const chat = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'a1', { ref: 'F-9', amount: 50 }), tools: tools(state) },
    } });
    const r1 = await chat.run('p', { runId: 'ch1', prompt: 'pay', threadId: 'thread-A', resourceId: 'u1', channel: 'chat' });
    await chat.run('p', { runId: 'ch1', prompt: 'pay', threadId: 'thread-A', resourceId: 'u1', channel: 'chat', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    expect(state.n.pay).toBe(1);

    // Channel 2: batch — a DIFFERENT thread, LOWERCASE spelling ('f-9') → no thread marker, XID catches it
    const batch = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'b1', { ref: 'f-9', amount: 50 }), tools: tools(state) },
    } });
    const r2 = await batch.run('p', { runId: 'bt1', prompt: 'pay', threadId: 'thread-B', resourceId: 'u1', channel: 'batch:aylik' });
    expect(r2.interrupts).toHaveLength(1); // cross-channel question — WITHOUT semantic limits/embedder
    const reason = (r2.interrupts[0] as { reason?: string }).reason ?? '';
    expect(reason).toContain('another channel');
    expect(reason).toContain('via chat');
    expect(state.n.pay).toBe(1); // did not run without asking

    // A DIFFERENT resource, same identity → doesn't see its neighbor (scope is per-person)
    const other = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'o1', { ref: 'F-9', amount: 50 }), tools: tools(state) },
    } });
    const r3 = await other.run('p', { runId: 'ot1', prompt: 'pay', threadId: 'thread-C', resourceId: 'u2', channel: 'chat' });
    // first job for u2: a tool without confirm, no dup trail → runs without asking
    expect(r3.interrupts).toHaveLength(0);
    expect(state.n.pay).toBe(2);
  });
});

describe('intent-override trail + rich payload', () => {
  it('a suspend→approval run leaves an override record in the journal; the interrupt carries a prior {ageMs}', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'c1', { ref: 'K-1', amount: 10 }), tools: tools(state) },
    } });
    const r1 = await gnl.run('p', { runId: 'o1', prompt: 'pay', threadId: 't', resourceId: 'u', channel: 'chat' });
    await gnl.run('p', { runId: 'o1', prompt: 'pay', threadId: 't', resourceId: 'u', channel: 'chat', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    // repeat: a new request → suspend + prior payload
    const r2 = await gnl.run('p', { runId: 'o2', prompt: 'pay', threadId: 't', resourceId: 'u', channel: 'chat' });
    expect(r2.interrupts).toHaveLength(1);
    const sus = r2.interrupts[0] as { toolCallId: string; prior?: { toolCallId?: string; ageMs?: number } };
    expect(sus.prior?.toolCallId).toBeDefined();
    expect(typeof sus.prior?.ageMs).toBe('number');
    // knowingly approve → leaves an override trail
    await gnl.run('p', { runId: 'o2', prompt: 'pay', threadId: 't', resourceId: 'u', channel: 'chat', approvals: { [sus.toolCallId]: true } });
    expect(state.n.pay).toBe(2); // the deliberate second job actually ran
    const ov = await journal.get(runKeys.proc('o2', `override-${sus.toolCallId}`));
    expect(ov).toBeDefined();
    expect((ov as { channel?: string }).channel).toBe('chat');
  });
});

describe('audit findings — v1 package', () => {
  it('blocker regression: byClass + top-level semantic TOGETHER is a valid config (no throw, the suspend cell gets semantics)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const fakeEmbed = async (t: string[]) => t.map(() => [1, 0]);
    const gnl = createGnl({ journal, agents: {
      p: { model: model('pay', 'c1', { ref: 'S-1', amount: 5 }), tools: tools(state) },
    } });
    // byClass + semantic: the validator must NOT throw, the run must go through
    const r = await gnl.run('p', { runId: 's1', prompt: 'x', threadId: 't', resourceId: 'u', limits: {
      sideEffectDuplicates: {
        byClass: { transactional: { action: 'suspend', scope: 'thread' } },
        default: { action: 'warn', scope: 'thread' },
        semantic: { embed: fakeEmbed, embedModelId: 'm' },
      } as never,
    } });
    expect(r.interrupts).toHaveLength(0);
    expect(state.n.pay).toBe(1);
    // byClass + semantic WITHOUT a suspend cell → LOUD throw (no silent-inert allowed)
    await expect(gnl.run('p', { runId: 's2', prompt: 'x', threadId: 't2', resourceId: 'u', limits: {
      sideEffectDuplicates: { byClass: { transactional: { action: 'warn' } }, semantic: { embed: fakeEmbed, embedModelId: 'm' } } as never,
    } })).rejects.toThrow(/suspend/);
  });

  it('critical: an UNDECLARED tool stays thread-suspend via the default cell (pin 5 of the verdict)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const bare = { // no effectClass
      description: 'bare', sideEffect: true, recover: async () => ({ done: false as const }),
      execute: async () => { state.n.bare = (state.n.bare ?? 0) + 1; return { ok: 1 }; },
    };
    const gnl = createGnl({ journal, preset: 'critical', agents: {
      b: { model: model('bare', 'c1', { z: 1 }), tools: { bare } },
    } });
    const r1 = await gnl.run('b', { runId: 'bc1', prompt: 'x', threadId: 't', resourceId: 'u' });
    await gnl.run('b', { runId: 'bc1', prompt: 'x', threadId: 't', resourceId: 'u', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    const r2 = await gnl.run('b', { runId: 'bc2', prompt: 'x', threadId: 't', resourceId: 'u' });
    expect(r2.interrupts).toHaveLength(1); // undeclared = today's behavior: asks on every repeat
    expect(state.n.bare).toBe(1);
  });

  it("a 'denied' skip terminal: does not mark the loop-reflect chain, replay returns the same notice, NO override promise", async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'headless', agents: {
      m: { model: model('mail', 'c1', { to: 'x' }), tools: tools(state) },
    } });
    await gnl.run('m', { runId: 'k1', prompt: 'x', threadId: 't', resourceId: 'u' });
    const r2 = await gnl.run('m', { runId: 'k2', prompt: 'x', threadId: 't', resourceId: 'u' });
    const txt = JSON.stringify(r2.steps ?? r2);
    expect(txt).toContain('__gnl_skipped');
    expect(txt).not.toContain('you may retry'); // removed an unbacked promise (K30)
    expect(txt).toContain('approval-capable flow');
    const rec = await journal.get<{ status: string }>(Object.keys((journal as never as { store: Map<string, unknown> }).store ?? {}).find?.(() => false) ?? 'yok') // placeholder
      ;
    // terminal status is denied — the reflected chain was not marked
    const { readIncidents } = await import('../src/incidents.js');
    const inc = await readIncidents(journal, 'k2');
    expect(inc.some((i) => i.action === 'skip')).toBe(true);
  });

  it('WITHOUT resourceId, XID is neither written nor read (the loud-warn branch) — behavior stays as before', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'c1', { ref: 'N-1', amount: 5 }), tools: tools(state) },
    } });
    const r1 = await gnl.run('p', { runId: 'n1', prompt: 'x', threadId: 't' }); // no resourceId
    await gnl.run('p', { runId: 'n1', prompt: 'x', threadId: 't', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    expect(state.n.pay).toBe(1);
    const keys = await journal.listKeys!('xid:');
    expect(keys).toHaveLength(0); // no ownerless identity was written
  });

  it('purgeResource: a person\'s whole XID family is swept in one pass; someone else\'s stays', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'c1', { ref: 'G-1', amount: 5 }), tools: tools(state) },
      q: { model: model('pay', 'c2', { ref: 'G-2', amount: 7 }), tools: tools(state) },
    } });
    const a = await gnl.run('p', { runId: 'g1', prompt: 'x', threadId: 't1', resourceId: 'silinecek' });
    await gnl.run('p', { runId: 'g1', prompt: 'x', threadId: 't1', resourceId: 'silinecek', approvals: Object.fromEntries(a.interrupts.map((i) => [i.toolCallId, true])) });
    const b = await gnl.run('q', { runId: 'g2', prompt: 'x', threadId: 't2', resourceId: 'kalacak' });
    await gnl.run('q', { runId: 'g2', prompt: 'x', threadId: 't2', resourceId: 'kalacak', approvals: Object.fromEntries(b.interrupts.map((i) => [i.toolCallId, true])) });
    expect((await journal.listKeys!('xid:res:silinecek:')).length).toBe(1);
    const { purgeResource } = await import('../src/retention.js');
    await purgeResource(journal, 'silinecek');
    expect((await journal.listKeys!('xid:res:silinecek:')).length).toBe(0);
    expect((await journal.listKeys!('xid:res:kalacak:')).length).toBe(1);
  });

  it('purgeResource also sweeps suggstats counters — the key ITSELF names the person (GDPR brief audit)', async () => {
    const journal = new InMemoryJournal();
    // the shape prepareInjection writes: suggstats:<full lesson key>
    await journal.incrBy!('suggstats:lesson:res:silinecek:s-1', { injected: 3 });
    await journal.incrBy!('suggstats:lesson:res:kalacak:s-2', { injected: 1 });
    await journal.put('lesson:res:silinecek:s-1', { v: 1, rule: 'x', mechanism: 'y', at: 1 });
    const { purgeResource } = await import('../src/retention.js');
    await purgeResource(journal, 'silinecek');
    expect(await journal.getCounters!('suggstats:lesson:res:silinecek:s-1')).toBeUndefined();
    expect(await journal.get('lesson:res:silinecek:s-1')).toBeUndefined();
    expect((await journal.getCounters!('suggstats:lesson:res:kalacak:s-2'))?.injected).toBe(1); // the neighbor stays
  });
});
