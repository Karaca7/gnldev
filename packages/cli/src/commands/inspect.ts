// gnl inspect <runId> --step N — the CLI view of time-travel: materialized state at journal entry N
// (reconstructState). This is the differentiator command: snapshot-based durability layers have no equivalent (opaque snapshots).
import type * as Durable from '@gnl/durable';
import type { ReconstructedState } from '@gnl/durable';
import type { Command } from './types.js';
import { flag, flagBool, positional } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { bold, dim } from '../ansi.js';

export interface InspectResult {
  state: ReconstructedState;
  max: number;
}

/** Throws if the run doesn't exist, or if `step` is outside the valid 0..entries.length range. */
export async function inspectRunCore(config: GnlDevConfig, d: typeof Durable, runId: string, step: number): Promise<InspectResult> {
  const journal = getJournal(config, d);
  const entries = await journal.readRun(runId);
  if (entries.length === 0) throw new Error(`run not found: '${runId}'`);
  if (!Number.isInteger(step) || step < 0 || step > entries.length) {
    throw new Error(`--step out of range: ${step} (valid: 0..${entries.length} for run '${runId}')`);
  }
  return { state: d.reconstructState(entries, step), max: entries.length };
}

export const inspectCommand: Command = {
  name: 'inspect',
  group: 'inspect',
  summary: 'Time-travel: materialized state at journal entry N',
  usage: 'gnl inspect <runId> --step N [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const runId = positional(ctx.argv, 0);
    if (!runId) throw new Error('runId required: gnl inspect <runId> --step N');
    const stepRaw = flag(ctx.argv, 'step');
    if (stepRaw === undefined) throw new Error('--step required: gnl inspect <runId> --step N');
    const step = Number(stepRaw);
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';

    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    const { state, max } = await inspectRunCore(config, d, runId, step);

    if (json) {
      console.log(JSON.stringify({ runId, ...state, max }, null, 2));
      return;
    }
    console.log(`${bold(runId)}  ${dim(`step ${state.step}/${max}`)}`);
    console.log('');
    for (const m of state.messages) console.log(`  ${bold(m.role)}  ${JSON.stringify(m.content)}`);
    if (state.pending.length > 0) {
      console.log('');
      console.log(dim(`  pending (awaiting result): ${state.pending.map((p) => `${p.toolName}[${p.toolCallId}]`).join(', ')}`));
    }
  },
};
