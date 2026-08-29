// INTERSECTION VERIFICATION (integration agent): do I (4.1 model-claim + 4.4 stream-checkpoint),
// J (4.2 run-lock fencing) and K (4.3 tool retry/side-effect gating) TOGETHER, in a realistic
// crash/resume flow, still not break EXACTLY-ONCE? Two scenarios:
//
//  A) REAL process-kill + run-level lock: the child process runs the side-effect tool successfully
//     (I: model claim write-ahead + succeeded), then crashes HARD (the lock is NEVER released —
//     J's fencing must kick in). The parent takes over via the same SQLite file after the TTL and
//     resumes → the tool's charge must remain EXACTLY 1, the lock fencing token must change (a real
//     takeover), and after resume the lock must be released cleanly (NO permanent deadlock).
//
//  B) In-process "payment gateway error + operator approval" flow: a sideEffect:true tool fails on
//     the first attempt (unapproved) (K: SideEffectRetryBlockedError blocks an unapproved retry).
//     After K1: an unapproved resume no longer finishes NORMALLY — the block sentinel halts the
//     loop and runDurable THROWS SideEffectRetryBlockedError (previously the AI SDK swallowed the
//     error and the model would finish with "ordinary" text → the model could produce a NEW
//     toolCallId and slip past the guard). The operator resumes with approvals (SAME runId) → this
//     time the tool
//     ACTUALLY runs and SUCCEEDS (exactly-once: the total real charge is exactly 1). Throughout the
//     run, M4 lock (J) wraps it. NOTE (a finding carried over into uncertainty): since the tool
//     result was 'failed' in run1, and run1's NEXT model step is also journaled (the AI SDK moves
//     to the next step without canceling the tool error), that step's text is replayed UNCHANGED
//     (stale) in run2 — this becomes visible via I's 4.1(b) `replay:'strict'` divergence warning
//     (only a console.warn, NEVER a throw). This is a PRE-EXISTING boundary arising at the
//     intersection of the current "model step is cached by index" design with K's approval-based
//     retry — NOT a regression.
import { describe, it, expect, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { runDurable } from '../src/run.js';
import { acquireRunLock } from '../src/run-lock.js';
import { SideEffectRetryBlockedError } from '../src/errors.js';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { InMemoryJournal } from '../src/journal.js';
import { createMockModel } from './mock.js';
import { spawnFixtureEnv } from './fixtures/watchdog.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const childScript = join(here, 'fixtures', 'crash-run-lock.ts');

describe('INTERSECTION — I (model-claim) + J (lock fencing) + K (tool retry): real crash/resume', () => {
  // 60s, above the child's own 50s spawnSync bound — otherwise the 30s default fires first and the
  // subprocess guard is unreachable. Same ordering as multi-process-race.test.ts.
  it('child (holding lock) crashes hard → parent takes over via fencing after TTL → charge EXACTLY 1, lock clean', { timeout: 60_000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-durable-intersect-'));
    const dbPath = join(dir, 'runs.db');
    const sePath = join(dir, 'charges.txt');
    const runId = 'order-intersect';
    const lockKey = `${runId}:lock`;
    try {
      // Run 1 — child process: acquires the lock (ttl=150ms), performs the charge (succeeded), then process.exit(1).
      // process.exit does NOT run the finally block → the lock stays 'alive' in the journal (owner=child).
      const child = spawnSync(tsxBin, [childScript, dbPath, sePath, runId, '150'], { encoding: 'utf8', timeout: 50_000, env: spawnFixtureEnv() });
      // See process-kill.test.ts: a timed-out child comes back as `status: null`, which slips past a
      // bare `not.toBe(0)` and reads as a crash. Reachable since the ceiling went to 60s.
      expect(child.error, 'the child did not exit on its own — spawnSync gave up on it').toBeUndefined();
      expect(typeof child.status).toBe('number');
      expect(child.status).not.toBe(0); // really crashed
      expect(Number(readFileSync(sePath, 'utf8'))).toBe(1); // the charge happened once (BEFORE the crash)

      const b = new SqliteStorage(dbPath);

      // Does the lock still appear owned by 'child' after the crash? (real crash → release never ran)
      const lockAfterCrash = await b.runs.get<{ owner: string; token: string; expires: number }>(lockKey);
      expect(lockAfterCrash?.owner).toBe('child');
      const childToken = lockAfterCrash?.token;

      // Model step 1's claim (AFTER the charge, AT the moment of the crash) must remain 'running' — the crash is VISIBLE (I).
      const claim1 = await b.runs.get<{ status: string }>(`${runId}:proc:__gnl_model_claim:1`);
      expect(claim1?.status).toBe('running');

      // spawnSync itself (process start/end) typically takes much longer than the lock TTL (150ms)
      // (see process-kill.test.ti ~500ms) — but wait until the TTL expires anyway, to be safe.
      const remaining = (lockAfterCrash?.expires ?? 0) - Date.now();
      if (remaining > 0) await new Promise((r) => setTimeout(r, remaining + 20));

      // Parent — resumes with the SAME file + runId, with a NEW lock owner (representing a real "new process").
      const chargeCard = tool({
        description: 'charge',
        inputSchema: z.object({ amount: z.number() }),
        sideEffect: true,
        maxRetries: 5,
        execute: async ({ amount }) => {
          const n = Number(readFileSync(sePath, 'utf8')) || 0;
          writeFileSync(sePath, String(n + 1));
          return { charged: amount };
        },
      } as any);
      const model = createMockModel(async ({ prompt }: any) => {
        const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
        if (done === 0) return { content: [{ type: 'tool-call', toolCallId: 'call-charge', toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) }], finishReason: 'tool-calls', usage: {}, warnings: [] };
        return { content: [{ type: 'text', text: 'Charged.' }], finishReason: 'stop', usage: {}, warnings: [] };
      });

      const res = await runDurable({
        runId,
        journal: b.runs,
        model,
        tools: { chargeCard },
        prompt: 'charge',
        stopWhen: stepCountIs(6),
        lock: { owner: 'parent', ttlMs: 5000 },
      } as any);

      // EXACTLY-ONCE: DESPITE the crash + fencing takeover + retry-gating, the charge remained EXACTLY 1.
      expect(Number(readFileSync(sePath, 'utf8'))).toBe(1);
      expect(res.text).toContain('Charged');

      // Fencing really took over: the lock token CHANGED (child's old token is now invalid).
      const lockAfterResume = await b.runs.get<{ owner: string; token: string; expires: number }>(lockKey);
      // resume finished normally → runDurable's finally released the lock CLEANLY (expires:0).
      expect(lockAfterResume?.expires).toBe(0);
      expect(lockAfterResume?.token).not.toBe(childToken);

      // Model claim step1 is now 'succeeded' (it ran again during resume and SUCCEEDED).
      const claim1After = await b.runs.get<{ status: string }>(`${runId}:proc:__gnl_model_claim:1`);
      expect(claim1After?.status).toBe('succeeded');

      // NO permanent deadlock: the released lock can immediately be acquired by someone else.
      const nextLock = await acquireRunLock(b.runs, runId, 'someone-else', 5000);
      expect(nextLock).not.toBeNull();
      await nextLock!.release();

      await b.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('INTERSECTION — I (model-claim divergence) + J (lock) + K (approval-gated retry): no crash, approval flow', () => {
  it('sideEffect tool fails without approval → run finishes normally → resume with approvals produces exactly 1 real charge (total always 1)', async () => {
    const journal = new InMemoryJournal();
    const runId = 'combo-approval';
    let charges = 0;
    let attempt = 0;

    const paymentTool = {
      description: 'payment',
      sideEffect: true,
      maxRetries: 5,
      execute: async ({ amount }: { amount: number }) => {
        attempt++;
        if (attempt === 1) throw new Error('gateway-timeout'); // FIRST attempt: fails WITHOUT a real charge occurring
        charges++; // only a SUCCESSFUL attempt produces a real side effect
        return { charged: amount };
      },
    };

    // Model: if there is no tool result yet → tool-call. If a tool result EXISTS (regardless of
    // success or error, the AI SDK adds it to the prompt with the 'tool' role) → finishes with a
    // completion text (realistic: the model does NOT itself TRIGGER a retry in one go; the operator
    // resumes with approval).
    function makeModel() {
      return createMockModel(async ({ prompt }: any) => {
        const toolMsg = (prompt ?? []).find((m: any) => m.role === 'tool');
        if (!toolMsg) {
          return {
            content: [{ type: 'tool-call', toolCallId: 'call-1', toolName: 'paymentTool', input: JSON.stringify({ amount: 50 }) }],
            finishReason: 'tool-calls' as const,
            usage: {},
            warnings: [],
          };
        }
        const out = toolMsg.content?.[0]?.output;
        const isError = out?.type === 'error-text' || out?.type === 'error-json';
        return {
          content: [{ type: 'text', text: isError ? 'Waiting for approval (payment failed).' : 'Payment completed.' }],
          finishReason: 'stop' as const,
          usage: {},
          warnings: [],
        };
      });
    }

    // Run 1 — NO approval: the tool errors on the first attempt (no real charge), the run finishes NORMALLY (no crash).
    const res1 = await runDurable({
      runId,
      journal,
      model: makeModel(),
      tools: { paymentTool },
      prompt: 'pay',
      stopWhen: stepCountIs(4),
      lock: { owner: 'r1', ttlMs: 5000 },
    } as any);
    expect(charges).toBe(0); // the first attempt failed WITHOUT creating a charge
    expect(res1.text).toContain('Waiting for approval');
    const toolRec1 = await journal.get<any>(`${runId}:tool:call-1`);
    expect(toolRec1?.status).toBe('failed');
    expect(toolRec1?.attempts).toBe(1);

    // Did the lock release cleanly at the end of run1? (normal completion → finally release)
    const lockAfterRun1 = await journal.get<any>(`${runId}:lock`);
    expect(lockAfterRun1?.expires).toBe(0);

    // Run 2a — approval is STILL missing: retry is BLOCKED. After K1: the sentinel halts the loop,
    // runDurable THROWS SideEffectRetryBlockedError (the run does not finish normally — the model can
    // never get to a turn where it circumvents the guard) → the charge is still 0, attempts UNCHANGED
    // (the block never counts as an attempt).
    await expect(
      runDurable({
        runId,
        journal,
        model: makeModel(),
        tools: { paymentTool },
        prompt: 'pay',
        stopWhen: stepCountIs(4),
        lock: { owner: 'r2a', ttlMs: 5000 },
      } as any),
    ).rejects.toThrow(SideEffectRetryBlockedError);
    expect(charges).toBe(0);
    const toolRecBlocked = await journal.get<any>(`${runId}:tool:call-1`);
    expect(toolRecBlocked?.status).toBe('failed');
    expect(toolRecBlocked?.attempts).toBe(1); // the block never wrote an attempt to the journal
    // J: even on the throw path, the lock was released cleanly via finally (no permanent deadlock).
    const lockAfterRun2a = await journal.get<any>(`${runId}:lock`);
    expect(lockAfterRun2a?.expires).toBe(0);

    // Run 2b — approvals GRANTED + replay:'strict' (let's also observe I's divergence detector).
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res2b = await runDurable({
      runId,
      journal,
      model: makeModel(),
      tools: { paymentTool },
      approvals: { 'call-1': true },
      prompt: 'pay',
      stopWhen: stepCountIs(4),
      replay: 'strict',
      lock: { owner: 'r2b', ttlMs: 5000 },
    } as any);

    // EXACTLY-ONCE — the core guarantee: the approved retry produced the real charge EXACTLY 1 time
    // (the first failed attempt made no charge at all; the approved 2nd attempt made exactly 1; no
    // matter HOW MANY more times the run is invoked, it is now 'succeeded' → it never runs again).
    expect(charges).toBe(1);
    expect(attempt).toBe(2); // total real execute calls: 1 failed + 1 succeeded
    const toolRecFinal = await journal.get<any>(`${runId}:tool:call-1`);
    expect(toolRecFinal?.status).toBe('succeeded');

    // KNOWN LIMIT (NOT a regression — see the file-header note): since model step-1 (the text AFTER
    // the tool) was already journaled in run1, the SAME (stale) text is replayed here too — the tool
    // ACTUALLY succeeding this time does not invalidate that cache. `replay:'strict'` ONLY informs
        // about this via a divergence warning (it NEVER throws) — this legitimate resume is NOT broken.
    expect(res2b.text).toContain('Waiting for approval'); // stale replay — known limit, documented
    expect(warn).toHaveBeenCalled(); // I's divergence warning makes this intersection VISIBLE
    warn.mockRestore();

    // Lock (J): run2b also finished normally → released cleanly; none of the 3 consecutive different
    // owners (r1/r2a/r2b) CAUSED a permanent deadlock.
    const lockFinal = await journal.get<any>(`${runId}:lock`);
    expect(lockFinal?.expires).toBe(0);
  });
});
