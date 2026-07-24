// gnl rm <runId> [--yes] — permanently delete one run (purgeRun): the run's journal trace, its
// sub-agent/network children (cascade), and its memory marker. Never runs without confirmation:
// --yes skips the prompt; otherwise, in a TTY, a y/N prompt is shown; non-interactively it refuses.
import type * as Durable from '@gnl/durable';
import type { Command } from './types.js';
import { flag, flagBool, positional } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { yellow } from '../ansi.js';

/** The actual purge (no confirmation here — that's the CLI wrapper's job so this stays testable/pure). */
export async function purgeRunCore(config: GnlDevConfig, d: typeof Durable, runId: string): Promise<number> {
  const journal = getJournal(config, d);
  const entries = await journal.readRun(runId);
  if (entries.length === 0) throw new Error(`run not found: '${runId}'`);
  return d.purgeRun(journal, runId);
}

async function confirmInteractively(runId: string): Promise<boolean> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Permanently delete run '${runId}' and its children? [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export const rmCommand: Command = {
  name: 'rm',
  group: 'operate',
  summary: 'Permanently delete a run (and its sub-agent/network children)',
  usage: 'gnl rm <runId> [--yes] [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const runId = positional(ctx.argv, 0);
    if (!runId) throw new Error('runId required: gnl rm <runId>');
    const yes = flagBool(ctx.argv, 'yes');
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';

    // Confirmation gate BEFORE loadConfig: a destructive command should refuse/prompt without first
    // requiring a valid storage config to even be reachable.
    if (!yes) {
      if (process.stdin.isTTY && process.stdout.isTTY) {
        const ok = await confirmInteractively(runId);
        if (!ok) {
          console.log('Aborted.');
          return;
        }
      } else {
        throw new Error(`refusing to delete '${runId}' without confirmation (pass --yes, or run interactively)`);
      }
    }

    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));
    const deletedEntries = await purgeRunCore(config, d, runId);
    const journal = getJournal(config, d);
    const remaining = await journal.readRun(runId);
    if (remaining.length > 0) throw new Error(`purge of '${runId}' left ${remaining.length} entries behind (incomplete delete)`);

    if (json) {
      console.log(JSON.stringify({ runId, deletedEntries }, null, 2));
      return;
    }
    console.log(`${yellow('✓ deleted')} '${runId}' (${deletedEntries} journal entries)`);
  },
};
