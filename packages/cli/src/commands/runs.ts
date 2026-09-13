// gnl runs — list runs from the configured storage/journal. Read-only.
// Core logic (listRunsCore) is a pure function of (config, durable, options) → data, same testability
// pattern as dev-server.ts's buildDevApp: no console I/O, so tests can assert on the returned rows directly.
import type * as Durable from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { colorStatus, printTable } from '../ansi.js';

export interface RunsOptions {
  /** The FULL RunStatus vocabulary. This union used to stop at 'failed' while the row below already
   *  Knew about 'running', so `--status running` type-checked only through a cast at the call site. */
  status?: 'completed' | 'suspended' | 'failed' | 'running' | 'canceled';
  /**
   * WHICH JOB — an EXACT match against the caller's declared name (`RunSummary.workKey`).
   *
   * Never a prefix, and the same contract `JournalReader.listRunsPaged` states for this filter:
   * `invoice-4` must not answer for `invoice-4471`, or "show me this job" quietly becomes "show me
   * this family". Not a uniqueness lookup either — one name can have several runs (`#<n>` reruns,
   * two scopes that happen to share a string), so this answers with a list like every other filter.
   */
  workKey?: string;
  limit?: number;
}

export interface RunRow {
  runId: string;
  status: 'completed' | 'suspended' | 'failed' | 'running' | 'canceled';
  modelSteps: number;
  toolCalls: number;
  costUsd?: number;
  threadId?: string;
  /**
   * The caller's own name for this work, when one was declared.
   *
   * It is a column now because the id stopped being one. A derived run is `run1_<32 hex>`, and the
   * question an operator brings to this listing — "which run was the invoice job?" — has no answer
   * on an opaque id. Absent on every run started with a raw runId, which is most of them.
   */
  workKey?: string;
}

/** Newest-first (journal append order is ascending → reversed), same convention as studio's GET /runs. */
export async function listRunsCore(config: GnlDevConfig, d: typeof Durable, opts: RunsOptions = {}): Promise<RunRow[]> {
  const journal = getJournal(config, d);
  let summaries = [...(await journal.listRuns())].reverse();
  if (opts.status) summaries = summaries.filter((r) => r.status === opts.status);
  // FILTER BEFORE SLICE, like `--status` above and for the reason listRunsPaged spells out: filtering
  // after the slice silently drops matches off the page a caller asked for.
  if (opts.workKey) summaries = summaries.filter((r) => (r as { workKey?: string }).workKey === opts.workKey);
  if (opts.limit !== undefined) summaries = summaries.slice(0, opts.limit);
  return Promise.all(
    summaries.map(async (r) => {
      // getRunCost is best-effort per row: it never throws on missing/unknown usage (returns 0s), so a
      // single malformed record can't blow up the whole listing.
      const cost = await d.getRunCost(journal, r.runId).catch(() => undefined);
      const workKey = (r as { workKey?: string }).workKey;
      return {
        runId: r.runId, status: r.status, modelSteps: r.modelSteps, toolCalls: r.toolCalls,
        costUsd: cost?.costUsd, threadId: r.threadId,
        // Omitted rather than `undefined`-valued: `--json` output is read by scripts, and an absent
        // field says "this run declared nothing" more honestly than a null does.
        ...(workKey ? { workKey } : {}),
      };
    }),
  );
}

export const runsCommand: Command = {
  name: 'runs',
  group: 'inspect',
  summary: 'List runs (status, steps, cost)',
  usage: 'gnl runs [--status completed|suspended|failed|running|canceled] [--work-key <key>] [--limit N] [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const status = flag(ctx.argv, 'status');
    const STATUSES = ['completed', 'suspended', 'failed', 'running', 'canceled'] as const;
    if (status !== undefined && !(STATUSES as readonly string[]).includes(status)) {
      // A list, not a chain of !== — this line has now lagged the vocabulary three times ('failed',
      // 'running', 'canceled'); a chain invites the fourth, a list shared with the message does not.
      throw new Error(`--status must be one of ${STATUSES.join(', ')}, got '${status}'`);
    }
    const limitRaw = flag(ctx.argv, 'limit');
    let limit: number | undefined;
    if (limitRaw !== undefined) {
      limit = Number(limitRaw);
      if (!Number.isFinite(limit) || limit < 0) throw new Error(`--limit must be a non-negative number, got '${limitRaw}'`);
    }
    const workKey = flag(ctx.argv, 'work-key');
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';

    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    // No cast to a narrower union than STATUSES: the old one said 'completed' | 'suspended', so
    // --status failed/running was type-erased right where the validation had just proven it valid.
    const rows = await listRunsCore(config, d, { status: status as RunsOptions['status'], limit, ...(workKey ? { workKey } : {}) });

    if (json) {
      console.log(JSON.stringify(rows, null, 2));
      return;
    }
    if (rows.length === 0) {
      console.log('No runs found.');
      return;
    }
    // WORK KEY only appears when at least one row has one. A column of dashes on every listing would
    // be a permanent tax on the common case (raw runIds) to serve a feature the deployment is not
    // using; the moment one run declares a name, the column is there to read.
    const anyWorkKey = rows.some((r) => r.workKey);
    printTable(
      ['RUN ID', 'STATUS', 'MODEL STEPS', 'TOOL CALLS', 'COST (USD)', 'THREAD', ...(anyWorkKey ? ['WORK KEY'] : [])],
      rows.map((r) => [
        r.runId,
        colorStatus(r.status),
        String(r.modelSteps),
        String(r.toolCalls),
        r.costUsd != null ? `$${r.costUsd.toFixed(4)}` : '-',
        r.threadId ?? '-',
        ...(anyWorkKey ? [r.workKey ?? '-'] : []),
      ]),
    );
  },
};
