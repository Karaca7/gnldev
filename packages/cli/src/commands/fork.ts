// gnl fork <runId> [--step N] [--to newRunId] — non-destructive "re-run from here": copies the first
// N model steps (+ referenced tool results) to a new runId (forkRun). The differentiator counterpart
// of `gnl inspect`: inspect SHOWS a past state, fork lets you continue LIVE from it.
import type * as Durable from '@gnl/durable';
import type { ForkResult } from '@gnl/durable';
import type { Command } from './types.js';
import { flag, flagBool, positional } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { bold } from '../ansi.js';

export interface ForkOptions {
  /** Number of model steps to keep (default: ALL of them — a full live-continuable copy). */
  step?: number;
  to?: string;
}

export async function forkRunCore(config: GnlDevConfig, d: typeof Durable, runId: string, opts: ForkOptions = {}): Promise<ForkResult> {
  const journal = getJournal(config, d);
  const entries = await journal.readRun(runId);
  if (entries.length === 0) throw new Error(`run not found: '${runId}'`);
  const modelSteps = entries.filter((e) => e.kind === 'model').length;
  const step = opts.step ?? modelSteps;
  if (!Number.isInteger(step) || step < 0 || step > modelSteps) {
    throw new Error(`--step out of range: ${step} (valid: 0..${modelSteps} for run '${runId}')`);
  }
  return d.forkRun(journal, runId, step, opts.to);
}

export const forkCommand: Command = {
  name: 'fork',
  group: 'operate',
  summary: 'Copy a run (up to step N) into a new, live-continuable runId',
  usage: 'gnl fork <runId> [--step N] [--to newRunId] [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const runId = positional(ctx.argv, 0);
    if (!runId) throw new Error('runId required: gnl fork <runId>');
    const stepRaw = flag(ctx.argv, 'step');
    const to = flag(ctx.argv, 'to');
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';

    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    const result = await forkRunCore(config, d, runId, { step: stepRaw !== undefined ? Number(stepRaw) : undefined, to });

    if (json) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    console.log(`✓ forked '${runId}' → ${bold(result.newRunId)}  (${result.copiedModel} model steps, ${result.copiedTool} tool results copied)`);
  },
};
