// AUDIT: the approval decision was not first-class in the journal — `approvals` was passed as an
// EXTERNAL parameter on every call; in the 'approved but crashes before the tool runs' scenario
// (approved but the process died before execute finished) the decision was never PERSISTED
// anywhere — resume would still require the `approvals` parameter, forcing the caller to keep its
// own decision history.
//
// This file locks in the `resolveApprovals` fix in run.ts:
//  - EVERY decision in the parameter is written to the journal via `claim` (idempotent, first decision wins),
//  - if `journal.listKeys` is supported, existing approvals in the journal are MERGED with the parameter,
//  - on conflict, the FIRST decision in the journal wins + console.warn,
//  - if `listKeys` is missing, behavior is unchanged (limited to the parameter) — no regression.
import { describe, it, expect, vi } from 'vitest';
// Kayıt artık imzalı bir nesne; bu testler KARARI sabitliyor, kaydın ŞEKLİNİ değil.
import { decisionOf } from '../src/run.js';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { InMemoryJournal, runKeys, runDurable, streamDurable, parseJournalKey } from '../src/index.js';
import type { Journal } from '../src/index.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult, createMockStreamAgent } from './mock.js';

/** Above CLAIM_TTL_MS (30s) — a 'running' this old is a corpse, not a claim (crash-window.test.ts's twin). */
const STALE_MS = 60_000;

/** The gate every approval story below needs: an amount worth asking a human about. */
const bigChargeGuard = ({ toolName, args }: any) =>
  toolName === 'chargeCard' && (args as any).amount > 1000
    ? { action: 'require-approval' as const, reason: 'large amount' }
    : { action: 'allow' as const };

async function waitFor(cond: () => Promise<boolean>, ms = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('waitFor: condition timed out');
}

// Model that decides based on conversation state: 0 tool results → call chargeCard; then final text.
// (Even if the tool's execute FAILS/throws, the AI SDK converts it to a tool-error — the model still
// counts as having seen a "tool result"; see the `blockedOrThrow` comment at the top of durable-tool.ts.)
function makeModel() {
  return createMockModel(async ({ prompt }: any) => {
    const done = countToolResults(prompt);
    if (done === 0) return toolCallResult('chargeCard', 'call-1', { amount: 5000 });
    return finalTextResult('Done.');
  });
}

// execute THROWS while crash.active is true (crash simulation: tool dies WITHOUT/before completing).
function makeTools(counter: { charges: number }, crash: { active: boolean }) {
  return {
    chargeCard: tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        if (crash.active) throw new Error('CRASH: process died mid-execute');
        counter.charges++;
        return { charged: amount };
      },
    }),
  };
}

describe('first-class approval: approvals journal persistence', () => {
  it('PROOF: approved but crashes before the tool runs → resume WITHOUT the approvals parameter, the tool runs thanks to the journal', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const crash = { active: true };

    // Run 1: approved (via approvals) but the tool execute THROWS — the tool can't complete.
    const r1 = await runDurable({
      runId: 'proof-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, crash),
      approvals: { 'call-1': true },
      prompt: 'charge 5000',
    });
    expect(counter.charges).toBe(0); // the tool couldn't complete
    expect(r1.text).toBe('Done.'); // the run continued overall (the AI SDK swallowed the error)
    const toolRecord1 = await journal.get<any>(runKeys.tool('proof-1', 'call-1'));
    expect(toolRecord1.status).toBe('failed'); // trace of the crash

    // The approval decision must have been WRITTEN to the journal — INDEPENDENT of the approvals
    // parameter, at the top of run.ts.
    expect(decisionOf(await journal.get(runKeys.approval('proof-1', 'call-1')))).toBe(true);

    // Run 2: resume WITHOUT the approvals parameter — no more crash, the tool can complete this time.
    crash.active = false;
    const r2 = await runDurable({
      runId: 'proof-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, crash),
      prompt: 'charge 5000',
    });

    expect(counter.charges).toBe(1); // thanks to the journal approval, the retry was NOT blocked, the tool ran
    expect(r2.text).toBe('Done.');
  });

  it('a denial (false) also persists: false is written to the journal approval key', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const bigChargeGuard = ({ toolName, args }: any) =>
      toolName === 'chargeCard' && (args as any).amount > 1000
        ? { action: 'require-approval' as const, reason: 'large amount' }
        : { action: 'allow' as const };

    const r = await runDurable({
      runId: 'deny-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, { active: false }),
      guard: bigChargeGuard,
      approvals: { 'call-1': false },
      prompt: 'charge 5000',
    });

    expect(counter.charges).toBe(0); // denied, the tool never ran
    expect(r.text).toBe('Done.');
    // The denial decision was PERSISTED to the journal — not just in the tool's 'denied' terminal
    // state, but also in the separate approval key (so it can be enumerated/observed later via listKeys).
    expect(decisionOf(await journal.get(runKeys.approval('deny-1', 'call-1')))).toBe(false);
  });

  it('a later DIFFERENT answer wins while the call has not completed (the crash must not lose an answer — it must not freeze one either)', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const crash = { active: true };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      // Run 1: approval TRUE, the tool crashes (can't complete) — 'true' is written to the journal (first decision).
      await runDurable({
        runId: 'conflict-1',
        journal,
        model: makeModel(),
        tools: makeTools(counter, crash),
        approvals: { 'call-1': true },
        prompt: 'charge 5000',
      });
      expect(counter.charges).toBe(0);
      expect(decisionOf(await journal.get(runKeys.approval('conflict-1', 'call-1')))).toBe(true);

      // Run 2: CONFLICTING parameter (false) — the FIRST decision (true) in the journal must WIN, must NOT be overwritten.
      crash.active = false;
      // Ret kazanınca çökmüş yan etkili çağrı otomatik YENİDEN DENENMEZ — ve motor bunu açıkça
      // söyler ("not auto-retried after failed"). Koşum tamamlanmaz: doğru olan da bu, çünkü
      // yarım kalmış bir para hareketi hakkında son söz yine insana ait.
      await expect(runDurable({
        runId: 'conflict-1',
        journal,
        model: makeModel(),
        tools: makeTools(counter, crash),
        approvals: { 'call-1': false }, // fikir değişikliği: iş henüz olmadı, ret geçerli
        prompt: 'charge 5000',
      })).rejects.toThrow(/not auto-retried after failed/);

      // NİYET DEĞİŞTİ, VE KASITLI. Bu iddia eskiden `charges === 1` diyordu: journal'daki 'true'
      // kazanıyor, araç KOŞUYORDU. Ölçüldü ki o kol tam olarak şu hikâyeyi üretiyor — operatör
      // Onayla'ya basar, araç çöker (kayıt 'failed'), operatör Reddet'e basar, ARAÇ YİNE ÇALIŞIR.
      // 'failed' terminal DEĞİLDİR: recover/reclaim merdiveni onu devralıp yeniden koşturur.
      //
      // "İlk karar kazanır" kuralının koruduğu şey, bir çökmenin CEVABI KAYBETMEMESİDİR — ve o
      // korunuyor: kimse fikir değiştirmezse karar aynen yaşar (üstteki iki test bunu sabitliyor).
      // Koruması gerekmeyen şey, iş HENÜZ OLMAMIŞKEN gelen yeni bir insan cevabını yenmektir.
      expect(counter.charges).toBe(0); // ret kazandı → araç KOŞMADI
      expect(decisionOf(await journal.get(runKeys.approval('conflict-1', 'call-1')))).toBe(false);
      // Çatışma uyarısı artık yok: çatışma DEĞİL, fikir değişikliği. Uyarı yalnız iş bittikten
      // sonra gelen (ve yok sayılan) cevap için basılıyor.
      expect(warnSpy).not.toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The mind-change window has an END, and it is not the terminal record — it is the moment execute
  // starts. Between those two the tool is holding a live claim and moving money; a second answer that
  // arrives there is not a change of mind, it is a race that already lost. Overwriting the approval
  // with it left the journal saying "reddedildi" next to a tool record saying "succeeded": nothing was
  // double-charged, but the audit trail described a charge that nobody authorised. That contradiction
  // is the ONLY thing these two tests are about — the run's behaviour is identical either way.
  it('a deny that arrives while execute is STILL RUNNING does not rewrite the approval it lost to', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    let entered = false;
    let release!: () => void;
    const inFlight = new Promise<void>((r) => { release = r; });

    const hangingTools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          entered = true;
          await inFlight; // the side effect is underway and has not landed yet
          counter.charges++;
          return { charged: amount };
        },
      }),
    };

    // Run 1: approved, guard passes it, execute starts and PARKS mid-flight.
    const first = runDurable({
      runId: 'inflight-1',
      journal,
      model: makeModel(),
      tools: hangingTools,
      guard: bigChargeGuard,
      approvals: { 'call-1': true },
      prompt: 'charge 5000',
    });
    await waitFor(async () => entered && (await journal.get<any>(runKeys.tool('inflight-1', 'call-1')))?.status === 'running');

    // Run 2: the operator changes their mind — but the work is already happening. The claim is FRESH,
    // so this call is turned away at the door (RunBusyError), which is exactly the pre-existing
    // behaviour; what must not happen alongside it is a rewritten decision.
    await expect(runDurable({
      runId: 'inflight-1',
      journal,
      model: makeModel(),
      tools: hangingTools,
      guard: bigChargeGuard,
      approvals: { 'call-1': false },
      prompt: 'charge 5000',
    })).rejects.toThrow(/another executor/);
    expect(decisionOf(await journal.get(runKeys.approval('inflight-1', 'call-1')))).toBe(true);

    // And when the side effect finally lands, the journal tells one story, not two.
    release();
    await first;
    expect(counter.charges).toBe(1);
    expect((await journal.get<any>(runKeys.tool('inflight-1', 'call-1'))).status).toBe('succeeded');
    expect(decisionOf(await journal.get(runKeys.approval('inflight-1', 'call-1')))).toBe(true);
  });

  it('a BAYAT running (the worker died holding the claim) is still re-answerable — the deny wins', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    // The shape a crash leaves behind: an approval on record and a 'running' marker nobody is
    // standing behind any more. The reclaim ladder will take this over and re-run it, so a human
    // must still be able to say "don't" — freezing the decision here would be the freeze the
    // first-decision-wins rule was never meant to give.
    await journal.put(runKeys.approval('stale-1', 'call-1'), { v: 1, decision: true, at: Date.now() - STALE_MS });
    await journal.put(runKeys.tool('stale-1', 'call-1'), { status: 'running', startedAt: Date.now() - STALE_MS });

    await runDurable({
      runId: 'stale-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, { active: false }),
      guard: bigChargeGuard,
      approvals: { 'call-1': false },
      prompt: 'charge 5000',
    });

    expect(decisionOf(await journal.get(runKeys.approval('stale-1', 'call-1')))).toBe(false);
    expect((await journal.get<any>(runKeys.tool('stale-1', 'call-1'))).status).toBe('denied');
    expect(counter.charges).toBe(0); // the abandoned call was NOT picked back up
  });

  // The mind-change semantics had never been driven through streamDurable — and streaming is the path
  // chat/agui resume on, so it is the path an operator's second click actually arrives by. It carries
  // its own copy of the probe; a parity test is the only thing that keeps the two copies one rule.
  it('STREAM path: approve → crash → deny, and the crashed side effect is NOT pulled a second time', async () => {
    const journal = new InMemoryJournal();
    const counter = { charges: 0 };
    const crash = { active: true };
    const tools = {
      chargeCard: tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        execute: async ({ amount }) => {
          if (crash.active) throw new Error('CRASH: process died mid-execute');
          counter.charges++;
          return { charged: amount };
        },
      }),
    };

    // Stream 1: approved, execute dies → the record is 'failed' and the decision is on file.
    const s1 = await streamDurable({
      runId: 'stream-conflict-1', journal, model: createMockStreamAgent(), tools,
      approvals: { 'call-charge': true }, prompt: 'charge 20', stopWhen: stepCountIs(3),
    });
    await s1.text;
    expect(counter.charges).toBe(0);
    expect((await journal.get<any>(runKeys.tool('stream-conflict-1', 'call-charge'))).status).toBe('failed');
    expect(decisionOf(await journal.get(runKeys.approval('stream-conflict-1', 'call-charge')))).toBe(true);

    // Stream 2: the operator denies. Nothing has happened yet — 'failed' is not terminal, the reclaim
    // ladder would have re-run this — so the new answer takes over, and the charge stays unmade.
    crash.active = false;
    const blocked: any[] = [];
    const s2 = await streamDurable({
      runId: 'stream-conflict-1', journal, model: createMockStreamAgent(), tools,
      approvals: { 'call-charge': false }, prompt: 'charge 20', stopWhen: stepCountIs(3),
      onBlocked: (b) => { blocked.push(b); },
    });
    // Same ending as the generate-path twin above: a half-made money movement is not auto-retried,
    // and the stream reports that through its terminal promise instead of finishing quietly.
    await expect(s2.text).rejects.toThrow(/not auto-retried after failed/);

    expect(decisionOf(await journal.get(runKeys.approval('stream-conflict-1', 'call-charge')))).toBe(false);
    expect(counter.charges).toBe(0); // ret kazandı → araç YİNE koşmadı
    expect(blocked.map((b) => b.kind)).toContain('SideEffectRetryBlockedError');
  });

  it('journal WITHOUT listKeys support: enrichment is skipped, behavior is no WORSE than today (fallback)', async () => {
    // Minimal Journal: has get/put/putIfAbsent, NO listKeys (some adapters may support it).
    const inner = new InMemoryJournal();
    const journal: Journal = {
      get: (k) => inner.get(k),
      put: (k, v) => inner.put(k, v),
      putIfAbsent: (k, v) => inner.putIfAbsent(k, v),
    };
    const counter = { charges: 0 };
    const crash = { active: true };

    // Run 1: approved but crashes — the approval IS WRITTEN to the journal (step (a), doesn't require
    // listKeys) but without listKeys a SUBSEQUENT run can't read it back to enrich.
    const r1 = await runDurable({
      runId: 'nolistkeys-1',
      journal,
      model: makeModel(),
      tools: makeTools(counter, crash),
      approvals: { 'call-1': true },
      prompt: 'charge 5000',
    });
    expect(counter.charges).toBe(0);
    expect(r1.text).toBe('Done.');

    // Run 2: WITHOUT the approvals parameter — no listKeys → ctx.approvals can't be enriched (fallback) →
    // the retry is BLOCKED with the OLD behavior (no regression: no retry unless approvals is explicitly given again).
    crash.active = false;
    await expect(
      runDurable({
        runId: 'nolistkeys-1',
        journal,
        model: makeModel(),
        tools: makeTools(counter, crash),
        prompt: 'charge 5000',
      }),
    ).rejects.toThrow(/side effects|not auto-retried/i);
    expect(counter.charges).toBe(0); // still hasn't run — the safe side is preserved
  });

  it("parseJournalKey: the approval key (outside model|tool) is INVISIBLE to reader/time-travel", () => {
    const key = runKeys.approval('some-run', 'call-1');
    expect(key).toBe('some-run:approval:call-1');
    expect(parseJournalKey(key)).toBeNull();
  });
});
