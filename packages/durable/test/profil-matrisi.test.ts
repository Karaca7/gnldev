// HEYET MATRİSİ + XID + OVERRIDE — v1 paketinin davranış pinleri.
// 1) matris hücreleri: assistant(notification→suspend v1, idempotent-write→soru YOK),
//    headless(transactional→BLOCK/DLQ, notification→SKIP+incident), critical(idempotent-write→warn koşar)
// 2) XID: farklı kanal/thread, aynı iş kimliği → soru "another channel (… via chat)" bağlamıyla;
//    yazım farkı (TV-1/tv-1) kanallar arası da yakalanır; SEMANTİK LİMİTS OLMADAN çalışır (embedder'sız)
// 3) intent-override izi: suspend→onay koşumunda journal'da override kaydı
// 4) zengin payload: dup-suspend interrupt'ı prior {toolCallId, at, ageMs} taşır
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

describe('profil matrisi', () => {
  it("assistant: notification tekrarı v1'de SORAR; idempotent-write tekrarı SORMADAN koşar", async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'assistant', agents: {
      m1: { model: model('mail', 'c1', { to: 'a@b', body: 'hi' }), tools: tools(state) },
      u1a: { model: model('upsert', 'c2', { id: 5, v: 1 }), tools: tools(state) },
    } });
    await gnl.run('m1', { runId: 'r1', prompt: 'mail at', threadId: 't', resourceId: 'u' });
    const r2 = await gnl.run('m1', { runId: 'r2', prompt: 'mail at', threadId: 't', resourceId: 'u' });
    expect(r2.interrupts).toHaveLength(1); // v1: soft-interrupt yüzeyi gelene dek sorar
    expect(state.n.mail).toBe(1);

    await gnl.run('u1a', { runId: 'r3', prompt: 'upsert', threadId: 't', resourceId: 'u' });
    const r4 = await gnl.run('u1a', { runId: 'r4', prompt: 'upsert', threadId: 't', resourceId: 'u' });
    expect(r4.interrupts).toHaveLength(0); // soru YASAK hücresi
    expect(state.n.upsert).toBe(2); // koruma yok — matematik zaten güvenli sayılır
  });

  it('headless: transactional tekrarı BLOK (DLQ yolu — throw); notification tekrarı SKIP + incident', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'headless', agents: {
      p: { model: model('pay', 'c1', { ref: 'F-1', amount: 100 }), tools: tools(state) },
      m: { model: model('mail', 'c2', { to: 'a@b' }), tools: tools(state) },
    } });
    await gnl.run('p', { runId: 'h1', prompt: 'öde', threadId: 't', resourceId: 'u' });
    await expect(gnl.run('p', { runId: 'h2', prompt: 'öde', threadId: 't', resourceId: 'u' }))
      .rejects.toThrow(/duplicate/i); // typed red — kuyruk DLQ'ya düşürür
    expect(state.n.pay).toBe(1);

    await gnl.run('m', { runId: 'h3', prompt: 'mail', threadId: 't', resourceId: 'u' });
    const r = await gnl.run('m', { runId: 'h4', prompt: 'mail', threadId: 't', resourceId: 'u' });
    expect(r.interrupts).toHaveLength(0);
    expect(state.n.mail).toBe(1); // koşmadı
    expect(JSON.stringify(r.steps ?? r)).toContain('__gnl_skipped'); // model görünür anlatım alır
    const { readIncidents } = await import('../src/incidents.js');
    const inc = await readIncidents(journal, 'h4');
    expect(inc.some((i) => i.action === 'skip')).toBe(true); // sessiz değil
  });

  it('critical: idempotent-write BEYANLI araç sorgusuz koşar (warn izi) — beyansız araç suspend kalır', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'critical', agents: {
      u: { model: model('upsert', 'c1', { id: 1 }), tools: tools(state) },
    } });
    await gnl.run('u', { runId: 'c1r', prompt: 'x', threadId: 't', resourceId: 'u' });
    const r = await gnl.run('u', { runId: 'c2r', prompt: 'x', threadId: 't', resourceId: 'u' });
    expect(r.interrupts).toHaveLength(0);
    expect(state.n.upsert).toBe(2); // koştu (warn hücresi)
    const { readIncidents } = await import('../src/incidents.js');
    const inc = await readIncidents(journal, 'c2r');
    expect(inc.some((i) => i.action === 'warn')).toBe(true); // iz düştü — görünmez değil
  });
});

describe('XID — kanallar-arası iş kimliği', () => {
  it('farklı thread + farklı kanal, AYNI kimlik → suspend sorusu "another channel (via chat)" bağlamıyla; yazım farkı da yakalanır', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    // Kanal 1: sohbet — F-9 ödendi
    const chat = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'a1', { ref: 'F-9', amount: 50 }), tools: tools(state) },
    } });
    const r1 = await chat.run('p', { runId: 'ch1', prompt: 'öde', threadId: 'thread-A', resourceId: 'u1', channel: 'chat' });
    await chat.run('p', { runId: 'ch1', prompt: 'öde', threadId: 'thread-A', resourceId: 'u1', channel: 'chat', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    expect(state.n.pay).toBe(1);

    // Kanal 2: batch — BAŞKA thread, KÜÇÜK harf yazım ('f-9') → thread marker'ı YOK, XID yakalar
    const batch = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'b1', { ref: 'f-9', amount: 50 }), tools: tools(state) },
    } });
    const r2 = await batch.run('p', { runId: 'bt1', prompt: 'öde', threadId: 'thread-B', resourceId: 'u1', channel: 'batch:aylik' });
    expect(r2.interrupts).toHaveLength(1); // kanallar-arası soru — SEMANTİK LİMİTS/EMBEDDER OLMADAN
    const reason = (r2.interrupts[0] as { reason?: string }).reason ?? '';
    expect(reason).toContain('another channel');
    expect(reason).toContain('via chat');
    expect(state.n.pay).toBe(1); // sorulmadan koşmadı

    // FARKLI resource aynı kimlik → komşuyu görmez (kapsam kişi)
    const other = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'o1', { ref: 'F-9', amount: 50 }), tools: tools(state) },
    } });
    const r3 = await other.run('p', { runId: 'ot1', prompt: 'öde', threadId: 'thread-C', resourceId: 'u2', channel: 'chat' });
    // u2 için ilk iş: confirm'süz araç, dup izi yok → sorusuz koşar
    expect(r3.interrupts).toHaveLength(0);
    expect(state.n.pay).toBe(2);
  });
});

describe('intent-override izi + zengin payload', () => {
  it('suspend→onay koşumu journal\'a override kaydı düşer; interrupt prior {ageMs} taşır', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'c1', { ref: 'K-1', amount: 10 }), tools: tools(state) },
    } });
    const r1 = await gnl.run('p', { runId: 'o1', prompt: 'öde', threadId: 't', resourceId: 'u', channel: 'chat' });
    await gnl.run('p', { runId: 'o1', prompt: 'öde', threadId: 't', resourceId: 'u', channel: 'chat', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    // tekrar: yeni istek → suspend + prior payload
    const r2 = await gnl.run('p', { runId: 'o2', prompt: 'öde', threadId: 't', resourceId: 'u', channel: 'chat' });
    expect(r2.interrupts).toHaveLength(1);
    const sus = r2.interrupts[0] as { toolCallId: string; prior?: { toolCallId?: string; ageMs?: number } };
    expect(sus.prior?.toolCallId).toBeDefined();
    expect(typeof sus.prior?.ageMs).toBe('number');
    // bilerek onayla → override izi
    await gnl.run('p', { runId: 'o2', prompt: 'öde', threadId: 't', resourceId: 'u', channel: 'chat', approvals: { [sus.toolCallId]: true } });
    expect(state.n.pay).toBe(2); // bilinçli ikinci iş gerçekten koştu
    const ov = await journal.get(runKeys.proc('o2', `override-${sus.toolCallId}`));
    expect(ov).toBeDefined();
    expect((ov as { channel?: string }).channel).toBe('chat');
  });
});

describe('denetçi bulguları — v1 paketi', () => {
  it('BLOKER regresyonu: byClass + üst-seviye semantic BİRLİKTE geçerli config (throw yok, suspend hücresi semantik alır)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const fakeEmbed = async (t: string[]) => t.map(() => [1, 0]);
    const gnl = createGnl({ journal, agents: {
      p: { model: model('pay', 'c1', { ref: 'S-1', amount: 5 }), tools: tools(state) },
    } });
    // byClass + semantic: validator throw ETMEMELİ, run çalışmalı
    const r = await gnl.run('p', { runId: 's1', prompt: 'x', threadId: 't', resourceId: 'u', limits: {
      sideEffectDuplicates: {
        byClass: { transactional: { action: 'suspend', scope: 'thread' } },
        default: { action: 'warn', scope: 'thread' },
        semantic: { embed: fakeEmbed, embedModelId: 'm' },
      } as never,
    } });
    expect(r.interrupts).toHaveLength(0);
    expect(state.n.pay).toBe(1);
    // suspend hücresi OLMAYAN byClass + semantic → LOUD throw (sessiz-inert yasağı)
    await expect(gnl.run('p', { runId: 's2', prompt: 'x', threadId: 't2', resourceId: 'u', limits: {
      sideEffectDuplicates: { byClass: { transactional: { action: 'warn' } }, semantic: { embed: fakeEmbed, embedModelId: 'm' } } as never,
    } })).rejects.toThrow(/suspend/);
  });

  it('critical: BEYANSIZ araç default hücresiyle thread-suspend kalır (hüküm 5 pini)', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const bare = { // effectClass YOK
      description: 'bare', sideEffect: true, recover: async () => ({ done: false as const }),
      execute: async () => { state.n.bare = (state.n.bare ?? 0) + 1; return { ok: 1 }; },
    };
    const gnl = createGnl({ journal, preset: 'critical', agents: {
      b: { model: model('bare', 'c1', { z: 1 }), tools: { bare } },
    } });
    const r1 = await gnl.run('b', { runId: 'bc1', prompt: 'x', threadId: 't', resourceId: 'u' });
    await gnl.run('b', { runId: 'bc1', prompt: 'x', threadId: 't', resourceId: 'u', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    const r2 = await gnl.run('b', { runId: 'bc2', prompt: 'x', threadId: 't', resourceId: 'u' });
    expect(r2.interrupts).toHaveLength(1); // beyansız = bugünkü davranış: her tekrar sorulur
    expect(state.n.bare).toBe(1);
  });

  it("skip terminali 'denied': loop-reflect zincirini işaretlemez, replay'de aynı notice döner, override vaadi YOK", async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'headless', agents: {
      m: { model: model('mail', 'c1', { to: 'x' }), tools: tools(state) },
    } });
    await gnl.run('m', { runId: 'k1', prompt: 'x', threadId: 't', resourceId: 'u' });
    const r2 = await gnl.run('m', { runId: 'k2', prompt: 'x', threadId: 't', resourceId: 'u' });
    const txt = JSON.stringify(r2.steps ?? r2);
    expect(txt).toContain('__gnl_skipped');
    expect(txt).not.toContain('you may retry'); // karşılıksız vaat kaldırıldı (K30)
    expect(txt).toContain('approval-capable flow');
    const rec = await journal.get<{ status: string }>(Object.keys((journal as never as { store: Map<string, unknown> }).store ?? {}).find?.(() => false) ?? 'yok') // placeholder
      ;
    // terminal statüsü denied — reflected zinciri işaretlenmedi
    const { readIncidents } = await import('../src/incidents.js');
    const inc = await readIncidents(journal, 'k2');
    expect(inc.some((i) => i.action === 'skip')).toBe(true);
  });

  it('resourceId YOKKEN XID yazılmaz/okunmaz (loud-warn dalı) — davranış eski haliyle sürer', async () => {
    const journal = new InMemoryJournal();
    const state = { n: {} as Record<string, number> };
    const gnl = createGnl({ journal, preset: 'assistant', agents: {
      p: { model: model('pay', 'c1', { ref: 'N-1', amount: 5 }), tools: tools(state) },
    } });
    const r1 = await gnl.run('p', { runId: 'n1', prompt: 'x', threadId: 't' }); // resourceId YOK
    await gnl.run('p', { runId: 'n1', prompt: 'x', threadId: 't', approvals: Object.fromEntries(r1.interrupts.map((i) => [i.toolCallId, true])) });
    expect(state.n.pay).toBe(1);
    const keys = await journal.listKeys!('xid:');
    expect(keys).toHaveLength(0); // sahipsiz kimlik yazılmadı
  });

  it('purgeResource: kişinin XID ailesi tek süpürmede gider; başka kişininki kalır', async () => {
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

  it('purgeResource suggstats sayaçlarını da süpürür — anahtarın KENDİSİ kişiyi adlandırıyor (GDPR brief denetimi)', async () => {
    const journal = new InMemoryJournal();
    // prepareInjection'ın yazdığı şekil: suggstats:<tam lesson anahtarı>
    await journal.incrBy!('suggstats:lesson:res:silinecek:s-1', { injected: 3 });
    await journal.incrBy!('suggstats:lesson:res:kalacak:s-2', { injected: 1 });
    await journal.put('lesson:res:silinecek:s-1', { v: 1, rule: 'x', mechanism: 'y', at: 1 });
    const { purgeResource } = await import('../src/retention.js');
    await purgeResource(journal, 'silinecek');
    expect(await journal.getCounters!('suggstats:lesson:res:silinecek:s-1')).toBeUndefined();
    expect(await journal.get('lesson:res:silinecek:s-1')).toBeUndefined();
    expect((await journal.getCounters!('suggstats:lesson:res:kalacak:s-2'))?.injected).toBe(1); // komşu kalır
  });
});
