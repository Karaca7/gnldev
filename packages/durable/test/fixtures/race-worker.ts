// Child worker for the REAL multi-process race suite (multi-process-race.test.ts). Two of these run
// as SEPARATE OS PROCESSES against the SAME SQLite file; a file barrier makes them hit the contended
// operation near-simultaneously. Results go to out-<id>.json (structured — a loser's RunBusyError is a
// RESULT, not a crash), so the parent asserts on data, never on exit-code guesswork.
//
//   argv: <mode> <dbPath> <outDir> <workerId>
//   modes: charge-lock | charge-claim | incr | grid | lock
import { existsSync, writeFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { tool, stepCountIs } from 'ai';
import { z } from 'zod';
import { runDurable } from '../../src/run.js';
import { compensateRun } from '../../src/compensation.js';
import { SqliteStorage } from '../../src/sqlite-storage.js';
import { armFixtureWatchdog } from './watchdog.js';

armFixtureWatchdog(); // never outlive the test that spawned this — see watchdog.ts

const [mode, dbPath, outDir, workerId] = process.argv.slice(2) as [string, string, string, string];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** File barrier: announce readiness, then spin until the parent (who waits for BOTH ready files)
 *  drops the 'go' file — both workers leave the barrier within one poll interval of each other. */
async function barrier(): Promise<void> {
  writeFileSync(join(outDir, `ready-${workerId}`), '1');
  const deadline = Date.now() + 10_000;
  while (!existsSync(join(outDir, 'go'))) {
    if (Date.now() > deadline) throw new Error('barrier timeout');
    await sleep(5);
  }
}

const out = (result: unknown) => writeFileSync(join(outDir, `out-${workerId}.json`), JSON.stringify(result));

const usage = { inputTokens: 10, outputTokens: 5, totalTokens: 15 };
const mkModel = (): any => ({
  specificationVersion: 'v2', provider: 'mock', modelId: 'mock', supportedUrls: {},
  doGenerate: async ({ prompt }: any) => {
    const done = (prompt ?? []).filter((m: any) => m.role === 'tool').length;
    if (done === 0) {
      return {
        content: [{ type: 'tool-call', toolCallId: 'call-charge', toolName: 'chargeCard', input: JSON.stringify({ amount: 20 }) }],
        finishReason: 'tool-calls', usage, warnings: [],
      };
    }
    return { content: [{ type: 'text', text: 'Charged.' }], finishReason: 'stop', usage, warnings: [] };
  },
  doStream: async () => { throw new Error('no stream'); },
});

const storage = new SqliteStorage(dbPath);
try {
  if (mode === 'charge-lock' || mode === 'charge-claim') {
    // The SAME runId from two processes. 'charge-lock' races the RUN-LOCK (acquireRunLock decides),
    // 'charge-claim' has NO lock → both enter the loop and the TOOL CLAIM (putIfAbsent NX) decides.
    // Two independent defense layers, each must yield EXACTLY ONE real charge on its own.
    const chargeCard = tool({
      description: 'charge',
      inputSchema: z.object({ amount: z.number() }),
      execute: async ({ amount }) => {
        appendFileSync(join(outDir, 'charges.txt'), `${workerId}\n`); // atomic small append: one line per REAL execution
        await sleep(300); // hold the claim/lock long enough that the loser lands inside the contention window
        return { charged: amount };
      },
    });
    await barrier();
    try {
      const res = await runDurable({
        runId: 'race-charge', journal: storage.runs, model: mkModel(), tools: { chargeCard },
        prompt: 'charge', stopWhen: stepCountIs(6),
        ...(mode === 'charge-lock' ? { lock: { owner: workerId, ttlMs: 10_000 } } : {}),
      });
      out({ ok: true, text: res.text });
    } catch (e: any) {
      out({ ok: false, error: String(e?.name ?? e) });
    }
  } else if (mode === 'incr') {
    // Cross-process H8a proof: K blind increments from EACH process on the same counter key —
    // engine-side UPSERT arithmetic must lose NOTHING under real file-level contention (WAL + busy_timeout).
    const K = 250;
    await barrier();
    for (let i = 0; i < K; i++) await storage.runs.incrBy!('race:ctr', { n: 1, cost: 0.5 });
    out({ ok: true, k: K });
  } else if (mode === 'grid') {
    // Cross-process putIfAbsent proof: both processes sweep the SAME N keys — every key must have
    // EXACTLY ONE winner, and each loser must have been told `false` (no silent double-claim).
    const N = 120;
    const wins: number[] = [];
    await barrier();
    for (let i = 0; i < N; i++) {
      if (await storage.runs.putIfAbsent!(`race:grid:k${i}`, { w: workerId })) wins.push(i);
    }
    out({ ok: true, wins });
  } else if (mode === 'compensate') {
    // Cross-process saga proof: BOTH processes unwind the SAME (parent-seeded) run concurrently —
    // each compensation's claim must admit exactly one executor (a refund can never run twice, even
    // across processes). Each hook execution appends one line; the hook sleeps to hold the claim so
    // the loser lands inside the contention window (and per the ordering invariant, stops as 'busy').
    const chargeCard = tool({
      description: 'charge',
      inputSchema: z.object({ orderId: z.string() }),
      execute: async () => ({ ok: true }),
    });
    (chargeCard as any).compensate = async (_args: unknown, _output: unknown, ctx: { toolCallId: string }) => {
      appendFileSync(join(outDir, 'comps.txt'), `${workerId}:${ctx.toolCallId}\n`);
      await sleep(150);
      return { refunded: true };
    };
    await barrier();
    const report = await compensateRun('race-saga', { journal: storage.runs, tools: { chargeCard } });
    out({ ok: true, entries: report.entries.map((e) => [e.toolCallId, e.status]) });
  } else if (mode === 'lock') {
    // Cross-process putIfMatch (H1 takeover) proof: both processes read the SAME stale record and
    // race the conditional replace — the engine-side compare must admit EXACTLY ONE.
    await barrier();
    const won = await storage.runs.putIfMatch!('race:lockrec', { holder: 'stale' }, { holder: workerId });
    out({ ok: true, won });
  } else {
    throw new Error(`unknown mode: ${mode}`);
  }
} finally {
  await storage.close();
}
