// Gnl sweep [--older-than 30d] [--include-suspended] [--yes] — retention sweep (sweepRuns): permanently
// Deletes runs whose last activity is older than the threshold. SAFE BY DEFAULT: without --yes/--force
// This only PREVIEWS what would be deleted (dry-run), it never mutates. `sweepRuns` itself has no
// Dry-run mode, so the preview mirrors its exact staleness predicate (age + keepSuspended) read-only
// Via listRuns/readRun/summarizeRun — the SAME primitives sweepRuns uses internally — but always takes
// The plain scan path (not the storage-specific listStaleRuns fast path sweepRuns may use for the real
// Delete); that's a deliberate simplicity/portability trade-off for a preview, not a correctness gap.
import type * as Durable from '@gnldev/durable';
import type { SweepResult } from '@gnldev/durable';
import type { Command } from './types.js';
import { flag, flagBool } from '../args.js';
import { loadConfig } from '../config.js';
import type { GnlDevConfig } from '../config.js';
import { getJournal, parseDuration } from '../journal-util.js';
import { loadDurable, projectDirOf } from '../runtime.js';
import { bold, dim, yellow } from '../ansi.js';

export interface SweepOptionsCli {
  olderThanMs: number;
  keepSuspended: boolean;
  now?: number;
}

export interface SweepPreview {
  scanned: number;
  wouldPurge: { runId: string; status: string; lastActivity: number }[];
  keptSuspended: number;
  keptNoTs: number;
}

export async function previewSweepCore(config: GnlDevConfig, d: typeof Durable, opts: SweepOptionsCli): Promise<SweepPreview> {
  const journal = getJournal(config, d);
  const now = opts.now ?? Date.now();
  const listed = await journal.listRuns();
  const preview: SweepPreview = { scanned: 0, wouldPurge: [], keptSuspended: 0, keptNoTs: 0 };
  for (const r of listed) {
    preview.scanned++;
    const entries = await journal.readRun(r.runId);
    const summary = d.summarizeRun(r.runId, entries);
    if (opts.keepSuspended && summary.status === 'suspended') {
      preview.keptSuspended++;
      continue;
    }
    const stamps = entries.map((e) => e.ts).filter((t): t is number => t != null);
    if (stamps.length === 0) {
      preview.keptNoTs++;
      continue;
    }
    const lastActivity = Math.max(...stamps);
    if (now - lastActivity > opts.olderThanMs) preview.wouldPurge.push({ runId: r.runId, status: summary.status, lastActivity });
  }
  return preview;
}

export async function sweepRunsCore(config: GnlDevConfig, d: typeof Durable, opts: SweepOptionsCli): Promise<SweepResult> {
  const journal = getJournal(config, d);
  return d.sweepRuns(journal, { olderThanMs: opts.olderThanMs, keepSuspended: opts.keepSuspended, now: opts.now });
}

const DEFAULT_OLDER_THAN = '30d';

export const sweepCommand: Command = {
  name: 'sweep',
  group: 'operate',
  summary: 'Retention sweep: permanently delete stale runs (dry-run by default)',
  usage: 'gnl sweep [--older-than 30d] [--include-suspended] [--dry-run] [--yes] [--json] [--config gnl.config.ts]',
  async run(ctx) {
    const olderThanRaw = flag(ctx.argv, 'older-than') ?? DEFAULT_OLDER_THAN;
    const olderThanMs = parseDuration(olderThanRaw);
    const keepSuspended = !flagBool(ctx.argv, 'include-suspended');
    const yes = flagBool(ctx.argv, 'yes') || flagBool(ctx.argv, 'force');
    const dryRun = flagBool(ctx.argv, 'dry-run') || !yes;
    const json = flagBool(ctx.argv, 'json');
    const configPath = flag(ctx.argv, 'config') ?? 'gnl.config.ts';

    const config = await loadConfig(configPath);
    const d = await loadDurable(projectDirOf(configPath));

    if (dryRun) {
      const preview = await previewSweepCore(config, d, { olderThanMs, keepSuspended });
      if (json) {
        console.log(JSON.stringify({ dryRun: true, olderThan: olderThanRaw, ...preview }, null, 2));
        return;
      }
      console.log(dim(`(dry-run — pass --yes to actually delete; older than ${olderThanRaw})`));
      if (preview.wouldPurge.length === 0) {
        console.log('No runs would be deleted.');
      } else {
        console.log(`Would delete ${bold(String(preview.wouldPurge.length))} run(s):`);
        for (const r of preview.wouldPurge) console.log(`  ${r.runId}  (${r.status}, last activity ${new Date(r.lastActivity).toISOString()})`);
      }
      console.log(dim(`scanned: ${preview.scanned}   kept (suspended): ${preview.keptSuspended}   kept (no timestamp): ${preview.keptNoTs}`));
      return;
    }

    const result = await sweepRunsCore(config, d, { olderThanMs, keepSuspended });
    if (json) {
      console.log(JSON.stringify({ dryRun: false, olderThan: olderThanRaw, ...result }, null, 2));
      return;
    }
    console.log(`${yellow('✓ deleted')} ${result.purged.length} run(s) (${result.deletedEntries} journal entries)`);
    for (const runId of result.purged) console.log(`  ${runId}`);
    console.log(dim(`scanned: ${result.scanned}   kept (suspended): ${result.keptSuspended}   kept (no timestamp): ${result.keptNoTs}`));
  },
};
