// FAZ-4 (dedup-hardening — kritik profil) — what's tested:
// 1) strictInput: a runId re-used with DIFFERENT content → RunInputMismatchError (409 family); the
//    SAME content replays; the suspend-trace exemption admits the chat approval re-POST shape.
// 2) actor binding: first-wins owner; a different actor is refused; no actor = no check.
// 3) tombstone: sweepRuns({tombstones:true}) writes `${runId}:swept`; tombstonePolicy 'reject'
//    refuses the late retry, the default re-runs (today's behavior).
// 4) suspendedTtlMs: an EXPIRED suspended run becomes sweepable; without the ttl it stays protected.
// 5) conflict ledger: refusals leave PII-free `idem:conflict:` records; readIdemLedger reads them,
//    and THROWS without listKeys (an empty answer must not misread as "no conflicts").
// 6) preset 'critical' (createGnl): toolPolicy/strictInput actually flow into runs.
import { describe, it, expect, vi } from 'vitest';
import { stepCountIs } from 'ai';
import { InMemoryJournal, runKeys } from '../src/journal.js';
import { runDurable } from '../src/run.js';
import { sweepRuns } from '../src/retention.js';
import { readIdemLedger } from '../src/idem-ledger.js';
import { RunInputMismatchError, RunActorMismatchError, RunSweptError } from '../src/errors.js';
import { createGnl } from '../src/registry.js';
import { createMockModel, countToolResults, toolCallResult, finalTextResult } from './mock.js';

const textModel = (text = 'done') => createMockModel(async () => finalTextResult(text));
const base = (journal: InMemoryJournal, runId: string, extra: Record<string, unknown> = {}) => ({
  runId, journal, stopWhen: stepCountIs(6), ...extra,
});

describe('FAZ-4 strictInput fingerprint', () => {
  it('different content on the same runId → RunInputMismatchError; same content replays', async () => {
    const journal = new InMemoryJournal();
    await runDurable(base(journal, 'si1', { model: textModel(), prompt: 'question A', strictInput: true }) as any);
    await expect(
      runDurable(base(journal, 'si1', { model: textModel(), prompt: 'question B', strictInput: true }) as any),
    ).rejects.toBeInstanceOf(RunInputMismatchError);
    // The SAME content is a legitimate retry → replay, no error.
    await expect(
      runDurable(base(journal, 'si1', { model: textModel(), prompt: 'question A', strictInput: true }) as any),
    ).resolves.toBeTruthy();
  });

  it("the suspend-trace exemption admits an approval re-POST with a GROWN history", async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = { charge: { sideEffect: true, confirm: true, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const model = () => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 5 }) : finalTextResult('done'));
    await runDurable(base(journal, 'si2', { model: model(), tools, prompt: 'charge it', strictInput: true }) as any);
    // Sonek: süreç-dışı entropi. Modül sayacı yalnız TEK süreç içindeki aynı-ms çarpışmasını
    // kapatıyordu; iki replika ortak journalda aynı `wf-<ad>-<ms>-0`ı üretip iki farklı çağrıyı tek
    // koşuma düşürebiliyordu (exactly-once'ın sessiz ihlali).
    expect(counter.n).toBe(0); // suspended by confirm
    // The approval re-POST carries DIFFERENT input (a grown chat history) + the approval for the
    // toolCallId whose journal record is genuinely 'suspended' → admitted, not 409'd.
    await runDurable(base(journal, 'si2', {
      model: model(), tools, prompt: 'charge it (history grew)', strictInput: true, approvals: { 'call-c': true },
    }) as any);
    expect(counter.n).toBe(1);
    // An approval naming NO suspended record earns nothing:
    await expect(
      runDurable(base(journal, 'si2', {
        model: model(), tools, prompt: 'yet another content', strictInput: true, approvals: { 'call-nonexistent': true },
      }) as any),
    ).rejects.toBeInstanceOf(RunInputMismatchError);
  });
});

describe('FAZ-4 actor binding', () => {
  it('first-wins owner; a different actor is refused; same actor passes', async () => {
    const journal = new InMemoryJournal();
    await runDurable(base(journal, 'ac1', { model: textModel(), prompt: 'x', actor: 'alice' }) as any);
    await expect(
      runDurable(base(journal, 'ac1', { model: textModel(), prompt: 'x', actor: 'bob' }) as any),
    ).rejects.toBeInstanceOf(RunActorMismatchError);
    await expect(
      runDurable(base(journal, 'ac1', { model: textModel(), prompt: 'x', actor: 'alice' }) as any),
    ).resolves.toBeTruthy();
  });

  it('no actor on either side = no check (documented auth-less bound)', async () => {
    const journal = new InMemoryJournal();
    await runDurable(base(journal, 'ac2', { model: textModel(), prompt: 'x' }) as any);
    await expect(runDurable(base(journal, 'ac2', { model: textModel(), prompt: 'x', actor: 'late-comer' }) as any)).resolves.toBeTruthy();
  });
});

describe('FAZ-4 tombstone', () => {
  it("sweep writes the tombstone; 'reject' refuses the late retry; the default re-runs", async () => {
    const journal = new InMemoryJournal();
    await runDurable(base(journal, 'tb1', { model: textModel(), prompt: 'x' }) as any);
    const swept = await sweepRuns(journal as any, { olderThanMs: 0, tombstones: true, now: Date.now() + 60_000 });
    expect(swept.purged).toContain('tb1');
    expect(await journal.get('tb1:swept')).toMatchObject({ at: expect.any(Number) });

    await expect(
      runDurable(base(journal, 'tb1', { model: textModel(), prompt: 'x', tombstonePolicy: 'reject' }) as any),
    ).rejects.toBeInstanceOf(RunSweptError);
    // Default policy: today's behavior — the swept id simply re-runs.
    await expect(runDurable(base(journal, 'tb1', { model: textModel(), prompt: 'x' }) as any)).resolves.toBeTruthy();
  });
});

describe('FAZ-4 suspendedTtlMs', () => {
  const suspendedRun = async (journal: InMemoryJournal, runId: string) => {
    const tools = { charge: { sideEffect: true, confirm: true, execute: async () => ({ ok: 1 }) } };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 5 }) : finalTextResult('done'));
    await runDurable(base(journal, runId, { model, tools, prompt: 'x' }) as any);
  };

  it('an expired suspended run becomes sweepable; without the ttl it stays protected', async () => {
    const journal = new InMemoryJournal();
    await suspendedRun(journal, 'su1');
    const later = Date.now() + 60_000;
    const kept = await sweepRuns(journal as any, { olderThanMs: 10, now: later });
    expect(kept.purged).not.toContain('su1'); // keepSuspended default: protected forever
    const sweptRes = await sweepRuns(journal as any, { olderThanMs: 10, suspendedTtlMs: 1_000, now: later });
    expect(sweptRes.purged).toContain('su1'); // the expiry arm: nobody came to approve it
  });
});

describe('FAZ-4 conflict ledger', () => {
  it('refusals leave PII-free records; readIdemLedger reads newest-first', async () => {
    const journal = new InMemoryJournal();
    await runDurable(base(journal, 'lg1', { model: textModel(), prompt: 'A', strictInput: true, conflictLedger: true, actor: 'alice' }) as any);
    await expect(
      runDurable(base(journal, 'lg1', { model: textModel(), prompt: 'B', strictInput: true, conflictLedger: true, actor: 'alice' }) as any),
    ).rejects.toBeInstanceOf(RunInputMismatchError);
    const ledger = await readIdemLedger(journal, { runId: 'lg1' });
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({ runId: 'lg1', code: 'run_input_mismatch', actor: 'alice' });
    expect(JSON.stringify(ledger[0])).not.toContain('question'); // PII-free: hashes only, never content
    expect(ledger[0]!.detail).toMatchObject({ expectedHash: expect.any(String), actualHash: expect.any(String) });
  });

  it('readIdemLedger THROWS without listKeys — no silent empty answer', async () => {
    const m = new Map<string, unknown>();
    const journal: any = { async get(k: string) { return m.get(k); }, async put(k: string, v: unknown) { m.set(k, v); } };
    await expect(readIdemLedger(journal)).rejects.toThrow(/listKeys/);
  });
});

describe("FAZ-4 preset 'critical' (createGnl)", () => {
  it('toolPolicy strict-critical flows: an unanswered side-effect tool is refused at run start', async () => {
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      preset: 'critical',
      agents: {
        pay: {
          model: createMockModel(async () => finalTextResult('done')),
          tools: { charge: { sideEffect: true, execute: async () => ({ ok: 1 }) } }, // no recover, no idempotencyKey
        } as any,
      },
    });
    await expect(gnl.run('pay', { runId: 'cp1', prompt: 'x' })).rejects.toThrow(/strict-critical/);
  });

  it('strictInput flows: a re-used runId with different content 409s through the preset', async () => {
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      preset: 'critical',
      agents: { chat: { model: createMockModel(async () => finalTextResult('ok')) } as any },
    });
    await gnl.run('chat', { runId: 'cp2', prompt: 'first content' });
    await expect(gnl.run('chat', { runId: 'cp2', prompt: 'second content' })).rejects.toBeInstanceOf(RunInputMismatchError);
  });
});

// FAZ-4 audit findings — resume/terminal-retry escapes, the stream twin gate, ledger branches, and
// the slow-path tombstone+suspendedTtl combo are pinned down.
import { streamDurable, resumeRun } from '../src/run.js';
import { createStreamMockModel } from './mock.js';

describe('FAZ-4 audit fixes', () => {
  it('an at-least-once retry of the SAME approval re-POST after completion replays — no permanent 409 (K18)', async () => {
    const journal = new InMemoryJournal();
    const counter = { n: 0 };
    const tools = { charge: { sideEffect: true, confirm: true, execute: async () => { counter.n++; return { ok: 1 }; } } };
    const model = () => createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 5 }) : finalTextResult('done'));
    await runDurable(base(journal, 'rt1', { model: model(), tools, prompt: 'v1', strictInput: true }) as any); // suspends
    const approvalCall = () => runDurable(base(journal, 'rt1', {
      model: model(), tools, prompt: 'v2-grown-history', strictInput: true, approvals: { 'call-c': true },
    }) as any);
    await approvalCall(); // approval lands, record → succeeded
    expect(counter.n).toBe(1);
    // The client's response was lost; its at-least-once retry re-sends the IDENTICAL request. The
    // record is no longer 'suspended' — the old exemption 409'd this legitimate replay.
    await expect(approvalCall()).resolves.toBeTruthy();
    expect(counter.n).toBe(1); // replay, not a re-fire
  });

  it('resumeRun with strictInput forwarded does NOT self-409 (frozen-content escape)', async () => {
    const journal = new InMemoryJournal();
    await runDurable(base(journal, 'rs1', { model: textModel(), prompt: 'original question', strictInput: true }) as any);
    // ResumeRun re-drives from the frozen :input; the stored-content escape must admit it.
    await expect(resumeRun('rs1', { journal, model: textModel(), strictInput: true } as any)).resolves.toBeTruthy();
  });

  it('the stream entry point enforces the SAME admission gate (K13/K15 stream twin)', async () => {
    const journal = new InMemoryJournal();
    await runDurable(base(journal, 'st1', { model: textModel(), prompt: 'content A', strictInput: true }) as any);
    await expect(
      streamDurable(base(journal, 'st1', { model: createStreamMockModel?.() ?? textModel(), prompt: 'content B', strictInput: true }) as any),
    ).rejects.toBeInstanceOf(RunInputMismatchError);
  });

  it('run_busy refusals land in the ledger too', async () => {
    const journal = new InMemoryJournal();
    // A live lock held by another owner:
    const { acquireRunLock } = await import('../src/run-lock.js');
    const held = await acquireRunLock(journal, 'lb1', 'other-worker', 60_000);
    expect(held).not.toBeNull();
    await expect(
      runDurable(base(journal, 'lb1', {
        model: textModel(), prompt: 'x', conflictLedger: true, actor: 'alice',
        lock: { owner: 'me', ttlMs: 60_000 },
      }) as any),
    ).rejects.toThrow(/locked by another process/);
    const ledger = await readIdemLedger(journal, { runId: 'lb1' });
    expect(ledger.some((r) => r.code === 'run_busy' && r.actor === 'alice')).toBe(true);
  });

  it('slow-path sweep: suspendedTtl expiry + tombstone written together', async () => {
    const journal = new InMemoryJournal();
    const tools = { charge: { sideEffect: true, confirm: true, execute: async () => ({ ok: 1 }) } };
    const model = createMockModel(async ({ prompt }: any) =>
      countToolResults(prompt) === 0 ? toolCallResult('charge', 'call-c', { amount: 5 }) : finalTextResult('done'));
    await runDurable(base(journal, 'sp1', { model, tools, prompt: 'x' }) as any); // suspended run
    const later = Date.now() + 60_000;
    // suspendedTtlMs forces the SLOW path; tombstones must be written there too.
    const res = await sweepRuns(journal as any, { olderThanMs: 10, suspendedTtlMs: 1_000, tombstones: true, now: later });
    expect(res.purged).toContain('sp1');
    expect(await journal.get('sp1:swept')).toMatchObject({ at: later });
    await expect(
      runDurable(base(journal, 'sp1', { model: textModel(), prompt: 'x', tombstonePolicy: 'reject' }) as any),
    ).rejects.toBeInstanceOf(RunSweptError);
  });
});

// runWorkflow anon-fallback contract (user finding #1): loud warn + an echoed runId + a counter
// against same-tick collisions.
describe('runWorkflow anon-fallback contract', () => {
  it('warns loudly, echoes the generated runId, and two same-tick calls never share one', async () => {
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      workflows: {
        w: { async run(input: unknown) { return { got: input }; }, build: () => [] } as any,
      },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const [a, b] = await Promise.all([gnl.runWorkflow('w', { n: 1 }), gnl.runWorkflow('w', { n: 2 })]);
      expect(a.runId).toMatch(/^wf-w-\d+-\d+-[0-9a-f]{8}$/); // echoed — the caller CAN retry against it
      expect(b.runId).toMatch(/^wf-w-\d+-\d+-[0-9a-f]{8}$/);
      expect(a.runId).not.toBe(b.runId); // same-tick calls must not share a journal
      expect(warn.mock.calls.some((c) => String(c[0]).includes('without a runId'))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it('an explicit runId stays silent and verbatim', async () => {
    const gnl = createGnl({
      journal: new InMemoryJournal(),
      workflows: { w: { async run() { return 1; }, build: () => [] } as any },
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const r = await gnl.runWorkflow('w', {}, { runId: 'my-stable-id' });
      expect(r.runId).toBe('my-stable-id');
      expect(warn.mock.calls.some((c) => String(c[0]).includes('without a runId'))).toBe(false);
    } finally {
      warn.mockRestore();
    }
  });
});
