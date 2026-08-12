// known limitation: there was no REAL persistence test for the suspend/approval flow — suspend.test.ts
// only tested with the same InMemoryJournal instance (never covering a process restart); process-kill.test.ts
// and exactly-once-intersection.test.ts only cover the CRASH path (process.exit mid-flight).
//
// This file applies process-kill.test.ts's REAL multi-process pattern (spawnSync + child script + a
// real SQLite FILE) to the suspend/approval flow:
//   1) Child 1: runDurable with a side-effecting tool behind a require-approval guard → the run is
//      suspended (interrupts is returned), the process exits NORMALLY (no process.exit — not a crash,
//      suspend persistence).
//   2) Parent: opens a NEW SqliteStorage on the SAME SQLite file → listRuns/summarizeRun must show the
//      run as 'suspended'; toolCallId+args must be readable back from the suspended record (proof that
//      an approval UI can reconstruct the flow even after a process restart).
//   3) Child 2 (SEPARATE execution): passes approvals DIRECTLY as a runDurable parameter (writing
//      approvals to the journal is an area where ANOTHER agent runs concurrently in run.ts — this test
//      is independent of that) → the tool runs EXACTLY once (proven by the external counter file), the
//      final answer is returned, the run is 'completed'.
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SqliteStorage } from '../src/sqlite-storage.js';
import { summarizeRun, runKeys } from '../src/journal.js';

const here = dirname(fileURLToPath(import.meta.url));
const tsxBin = join(here, '..', '..', '..', 'node_modules', '.bin', 'tsx');
const child1Script = join(here, 'fixtures', 'suspend-cross-process-child1.ts');
const child2Script = join(here, 'fixtures', 'suspend-cross-process-child2.ts');

describe('real cross-process suspend/approval persistence', () => {
  it('child1 suspends (exits normally) → parent (new instance) sees suspended + reads toolCallId/args → child2 approves and resumes → tool ran once, run completed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gnl-durable-suspend-'));
    const dbPath = join(dir, 'runs.db');
    const sePath = join(dir, 'charges.txt');
    const runId = 'order-suspend-cross';
    writeFileSync(sePath, '0'); // tool hasn't run yet
    try {
      // ── 1) Child 1: no approval → suspended, the tool does NOT run, process exits NORMALLY (NOT a crash) ──
      const child1 = spawnSync(tsxBin, [child1Script, dbPath, sePath, runId], { encoding: 'utf8' });
      expect(child1.stderr).toBe('');
      expect(child1.status).toBe(0); // normal exit — no crash, deliberate suspend
      expect(Number(readFileSync(sePath, 'utf8'))).toBe(0); // the tool never ran

      // ── 2) Parent: open the SAME file with a DIFFERENT SqliteStorage instance → verify persistence ──
      const b1 = new SqliteStorage(dbPath);

      const page = await b1.runs.listRuns();
      const summary = page.items.find((r) => r.runId === runId);
      expect(summary).toMatchObject({ runId, status: 'suspended', modelSteps: 1, toolCalls: 1 });

      // summarizeRun (journal read-API) must produce the SAME result — not derived from listRuns, an independent path.
      const entries = await b1.runs.readRun(runId);
      const summaryFromEntries = summarizeRun(runId, entries);
      expect(summaryFromEntries).toEqual({ runId, status: 'suspended', modelSteps: 1, toolCalls: 1 });

      // toolCallId + args can be READ BACK from the suspended record (an approval UI can see these
      // after a crash/restart and reconstruct the approval screen).
      const toolRec = await b1.runs.get<any>(runKeys.tool(runId, 'call-charge'));
      expect(toolRec).toMatchObject({
        status: 'suspended',
        output: {
          __gnl_suspend: {
            toolCallId: 'call-charge',
            toolName: 'chargeCard',
            args: { amount: 5000 },
            reason: 'large amount',
          },
        },
      });

      await b1.close();

      // ── 3) Child 2: separate execution, approvals via parameter → the tool runs EXACTLY once ──
      const child2 = spawnSync(tsxBin, [child2Script, dbPath, sePath, runId], { encoding: 'utf8' });
      expect(child2.stderr).toBe('');
      expect(child2.status).toBe(0);
      expect(Number(readFileSync(sePath, 'utf8'))).toBe(1); // exactly once — it never ran during suspend

      const resultLine = child2.stdout.split('\n').find((l) => l.startsWith('RESULT:'));
      expect(resultLine).toBeDefined();
      const { text } = JSON.parse(resultLine!.slice('RESULT:'.length));
      expect(text).toContain('Charged');

      // ── The run is now 'completed' — again with a NEW instance, persistence verified end-to-end ──
      const b2 = new SqliteStorage(dbPath);
      const page2 = await b2.runs.listRuns();
      const summary2 = page2.items.find((r) => r.runId === runId);
      expect(summary2).toMatchObject({ runId, status: 'completed', modelSteps: 2, toolCalls: 1 });

      const toolRecAfter = await b2.runs.get<any>(runKeys.tool(runId, 'call-charge'));
      expect(toolRecAfter).toMatchObject({ status: 'succeeded', output: { charged: 5000 } });

      await b2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
